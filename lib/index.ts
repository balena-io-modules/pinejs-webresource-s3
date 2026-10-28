import {
	DeleteObjectCommand,
	GetObjectCommand,
	S3Client,
	type PutObjectCommandInput,
	CreateMultipartUploadCommand,
	UploadPartCommand,
	CompleteMultipartUploadCommand,
	HeadObjectCommand,
	AbortMultipartUploadCommand,
	type StorageClass,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { webResourceHandler } from '@balena/pinejs';
import memoize from 'memoizee';
import { randomUUID } from 'node:crypto';

// Taken from pine as @balena/sbvr-types is not one of our dependencies
type WebResource = Parameters<
	webResourceHandler.WebResourceHandler['onPreRespond']
>[0];

export interface S3HandlerProps {
	region: string;
	accessKey: string;
	secretKey: string;
	endpoint: string;
	bucket: string;
	maxSize?: number;
	signedUrlExpireTimeSeconds?: number;
	signedUrlCacheExpireTimeSeconds?: number;
	// The least recently used signed urls are evicted past this many files
	signedUrlCacheMaxEntries?: number;
	minimumMultipartUploadSize?: number;
	defaultMultipartUploadSize?: number;
	storageClass?: StorageClass;
}

// The longest a SigV4 presigned url can be valid for, 7 days
const MAX_SIGNED_URL_EXPIRE_TIME_SECONDS = 7 * 24 * 60 * 60;

// Header values have to be printable ASCII: Node rejects characters above \xff and
// sends \x80-\xff as latin1 bytes whilst the SigV4 signature hashes them as UTF-8.
// Other names get an ASCII fallback plus an RFC 8187 `filename*` (RFC 6266 section 4.3)
const getContentDisposition = (filename: string) => {
	const asciiFilename = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
	if (asciiFilename === filename) {
		return `inline; filename="${filename}"`;
	}
	const encodedFilename = Array.from(Buffer.from(filename, 'utf8'), (byte) => {
		const char = String.fromCharCode(byte);
		// RFC 8187 attr-char, everything else is percent-encoded
		return /[\w!#$&+.^`|~-]/.test(char)
			? char
			: `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
	}).join('');
	return `inline; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
};

export class S3Handler implements webResourceHandler.WebResourceHandler {
	private readonly endpoint: string;
	private readonly bucket: string;
	private readonly maxFileSize: number;
	private readonly defaultMultipartUploadSize: number;
	private readonly minimumMultipartUploadSize: number;

	protected readonly signedUrlExpireTimeSeconds: number;
	protected readonly signedUrlCacheExpireTimeSeconds: number;
	protected readonly signedUrlCacheMaxEntries: number;
	protected readonly cachedGetSignedUrl: (fileKey: string) => Promise<string>;
	protected readonly storageClass: StorageClass | undefined;

	private readonly client: S3Client;

	constructor(config: S3HandlerProps) {
		this.endpoint = config.endpoint;

		this.signedUrlExpireTimeSeconds =
			config.signedUrlExpireTimeSeconds ?? 86400; // 24h
		this.signedUrlCacheExpireTimeSeconds =
			config.signedUrlCacheExpireTimeSeconds ?? 82800; // 22h
		// Each cached url retains roughly 1.25KB, so ~12.5MB at the default
		this.signedUrlCacheMaxEntries = config.signedUrlCacheMaxEntries ?? 10000;

		this.minimumMultipartUploadSize =
			config.minimumMultipartUploadSize ?? 5 * 1024 * 1024; // 5 MB
		this.defaultMultipartUploadSize =
			config.defaultMultipartUploadSize ?? 10 * 1024 * 1024; // 10 MB
		this.maxFileSize = config.maxSize ?? 52428800;

		// Reject values that could never work rather than failing on every request
		if (
			!Number.isSafeInteger(this.signedUrlExpireTimeSeconds) ||
			this.signedUrlExpireTimeSeconds <= 0 ||
			this.signedUrlExpireTimeSeconds > MAX_SIGNED_URL_EXPIRE_TIME_SECONDS
		) {
			throw new Error(
				`signedUrlExpireTimeSeconds must be an integer between 1 and ${MAX_SIGNED_URL_EXPIRE_TIME_SECONDS}`,
			);
		}
		if (
			Number.isNaN(this.signedUrlCacheExpireTimeSeconds) ||
			this.signedUrlCacheExpireTimeSeconds < 0 ||
			this.signedUrlCacheExpireTimeSeconds >= this.signedUrlExpireTimeSeconds
		) {
			throw new Error(
				'signedUrlCacheExpireTimeSeconds must be at least 0 and less than signedUrlExpireTimeSeconds',
			);
		}
		if (
			!Number.isSafeInteger(this.minimumMultipartUploadSize) ||
			this.minimumMultipartUploadSize <= 0
		) {
			throw new Error('minimumMultipartUploadSize must be a positive integer');
		}
		if (
			!Number.isSafeInteger(this.defaultMultipartUploadSize) ||
			this.defaultMultipartUploadSize < this.minimumMultipartUploadSize
		) {
			throw new Error(
				'defaultMultipartUploadSize must be an integer of at least minimumMultipartUploadSize',
			);
		}
		if (Number.isNaN(this.maxFileSize) || this.maxFileSize < 0) {
			throw new Error('maxSize must be a number of at least 0');
		}

		this.bucket = config.bucket;
		this.client = new S3Client({
			region: config.region,
			credentials: {
				accessKeyId: config.accessKey,
				secretAccessKey: config.secretKey,
			},
			endpoint: config.endpoint,
			forcePathStyle: true,
		});

		// Memoize expects maxAge in MS and s3 signing method in seconds.
		// Normalization to use only seconds and therefore convert here from seconds to MS
		// memoizee treats a maxAge of 0 as never expiring, so 0 disables the cache instead
		this.cachedGetSignedUrl =
			this.signedUrlCacheExpireTimeSeconds > 0
				? memoize(this.s3SignUrl, {
						maxAge: this.signedUrlCacheExpireTimeSeconds * 1000,
						promise: true,
						max: this.signedUrlCacheMaxEntries,
					})
				: this.s3SignUrl;
		this.storageClass = config.storageClass;
	}

	public async handleFile(
		resource: webResourceHandler.IncomingFile,
	): Promise<webResourceHandler.UploadResponse> {
		let size = 0;
		const key = this.getFileKey(resource.fieldname);
		const params: PutObjectCommandInput = {
			Bucket: this.bucket,
			Key: key,
			Body: resource.stream,
			ContentType: resource.mimetype,
			ContentDisposition: getContentDisposition(resource.originalname),
			StorageClass: this.storageClass,
		};
		const upload = new Upload({ client: this.client, params });

		upload.on('httpUploadProgress', async (ev) => {
			size = ev.total ?? ev.loaded!;
			if (size > this.maxFileSize) {
				await upload.abort();
			}
		});

		try {
			await upload.done();
		} catch (err) {
			resource.stream.resume();
			if (size > this.maxFileSize) {
				throw new webResourceHandler.FileSizeExceededError(this.maxFileSize);
			}
			throw err;
		}

		const filename = this.getS3URL(key);
		return { size, filename };
	}

	public async removeFile(href: string): Promise<void> {
		const fileKey = this.getKeyFromHref(href);

		const command = new DeleteObjectCommand({
			Bucket: this.bucket,
			Key: fileKey,
		});

		await this.client.send(command);
	}

	public async onPreRespond(webResource: WebResource): Promise<WebResource> {
		if (webResource.href != null) {
			const fileKey = this.getKeyFromHref(webResource.href);
			webResource.href = await this.cachedGetSignedUrl(fileKey);
		}
		return webResource;
	}

	public readonly multipartUpload = {
		begin: async (
			fieldName: string,
			payload: webResourceHandler.BeginMultipartUploadPayload,
		): Promise<webResourceHandler.BeginMultipartUploadHandlerResponse> => {
			const fileKey = this.getFileKey(fieldName);

			const createMultiPartResponse = await this.client.send(
				new CreateMultipartUploadCommand({
					Bucket: this.bucket,
					Key: fileKey,
					ContentType: payload.content_type,
					ContentDisposition: getContentDisposition(payload.filename),
					StorageClass: this.storageClass,
				}),
			);

			if (createMultiPartResponse.UploadId == null) {
				throw new Error('Failed to create multipart upload.');
			}

			const uploadParts = await this.getUploadParts(
				fileKey,
				createMultiPartResponse.UploadId,
				payload,
			);
			return {
				fileKey,
				uploadId: createMultiPartResponse.UploadId,
				uploadParts,
			};
		},

		commit: async ({
			fileKey,
			uploadId,
			filename,
			providerCommitData,
		}: webResourceHandler.CommitMultipartUploadPayload): Promise<WebResource> => {
			await this.client.send(
				new CompleteMultipartUploadCommand({
					Bucket: this.bucket,
					Key: fileKey,
					UploadId: uploadId,
					MultipartUpload: providerCommitData,
				}),
			);

			const headResult = await this.client.send(
				new HeadObjectCommand({
					Bucket: this.bucket,
					Key: fileKey,
				}),
			);

			return {
				href: this.getS3URL(fileKey),
				filename: filename,
				size: headResult.ContentLength,
				content_type: headResult.ContentType,
			};
		},

		cancel: async ({
			fileKey,
			uploadId,
		}: webResourceHandler.CancelMultipartUploadPayload): Promise<void> => {
			await this.client.send(
				new AbortMultipartUploadCommand({
					Bucket: this.bucket,
					Key: fileKey,
					UploadId: uploadId,
				}),
			);
		},
		getMinimumPartSize: () => {
			return this.minimumMultipartUploadSize;
		},

		getDefaultPartSize: () => {
			return this.defaultMultipartUploadSize;
		},
	};

	private s3SignUrl(fileKey: string): Promise<string> {
		const command = new GetObjectCommand({
			Bucket: this.bucket,
			Key: fileKey,
		});
		return getSignedUrl(this.client, command, {
			expiresIn: this.signedUrlExpireTimeSeconds,
		});
	}

	private getS3URL(key: string): string {
		return `${this.endpoint}/${this.bucket}/${key}`;
	}

	private getKeyFromHref(href: string): string {
		const hrefWithoutParams = webResourceHandler.normalizeHref(href);
		return hrefWithoutParams.substring(hrefWithoutParams.lastIndexOf('/') + 1);
	}

	private getFileKey(fieldName: string) {
		return `${fieldName}_${randomUUID()}`;
	}

	private async getUploadParts(
		fileKey: string,
		uploadId: string,
		payload: webResourceHandler.BeginMultipartUploadPayload,
	): Promise<webResourceHandler.UploadPart[]> {
		const chunkSizesWithParts = this.getChunkSizesWithParts(
			payload.size,
			payload.chunk_size,
		);
		return Promise.all(
			chunkSizesWithParts.map(async ({ chunkSize, partNumber }) => ({
				chunkSize,
				partNumber,
				url: await this.getPartUploadUrl(
					fileKey,
					uploadId,
					partNumber,
					chunkSize,
				),
			})),
		);
	}

	private async getPartUploadUrl(
		fileKey: string,
		uploadId: string,
		partNumber: number,
		partSize: number,
	): Promise<string> {
		const command = new UploadPartCommand({
			Bucket: this.bucket,
			Key: fileKey,
			UploadId: uploadId,
			PartNumber: partNumber,
			ContentLength: partSize,
		});

		return getSignedUrl(this.client, command, {
			expiresIn: this.signedUrlExpireTimeSeconds,
		});
	}

	private getChunkSizesWithParts(
		size: number,
		chunkSize: number,
	): Array<Pick<webResourceHandler.UploadPart, 'chunkSize' | 'partNumber'>> {
		const chunkSizesWithParts = [];
		let partNumber = 1;
		let remainingSize = size;
		while (remainingSize > 0) {
			const currentChunkSize = Math.min(remainingSize, chunkSize);
			chunkSizesWithParts.push({ chunkSize: currentChunkSize, partNumber });
			remainingSize -= currentChunkSize;
			partNumber += 1;
		}
		return chunkSizesWithParts;
	}
}

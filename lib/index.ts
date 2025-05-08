import {
	DeleteObjectCommand,
	GetObjectCommand,
	S3Client,
	type PutObjectCommandInput,
	type S3ClientConfig,
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

import type { WebResourceType as WebResource } from '@balena/sbvr-types';
import memoize from 'memoizee';
import { randomUUID } from 'node:crypto';
export interface S3HandlerProps {
	region: string;
	accessKey: string;
	secretKey: string;
	endpoint: string;
	bucket: string;
	maxSize?: number;
	signedUrlExpireTimeSeconds?: number;
	signedUrlCacheExpireTimeSeconds?: number;
	minimumMultipartUploadSize?: number;
	defaultMultipartUploadSize?: number;
	storageClass?: StorageClass;
}

const normalizeHref = (href: string) => {
	return href.split('?')[0];
};

export class S3Handler implements webResourceHandler.WebResourceHandler {
	private readonly config: S3ClientConfig;
	private readonly bucket: string;
	private readonly maxFileSize: number;
	private readonly defaultMultipartUploadSize: number;
	private readonly minimumMultipartUploadSize: number;

	protected readonly signedUrlExpireTimeSeconds: number;
	protected readonly signedUrlCacheExpireTimeSeconds: number;
	protected cachedGetSignedUrl: (fileKey: string) => Promise<string>;
	protected readonly storageClass: StorageClass;

	private client: S3Client;

	constructor(config: S3HandlerProps) {
		this.config = {
			region: config.region,
			credentials: {
				accessKeyId: config.accessKey,
				secretAccessKey: config.secretKey,
			},
			endpoint: config.endpoint,
			forcePathStyle: true,
		};

		this.signedUrlExpireTimeSeconds =
			config.signedUrlExpireTimeSeconds ?? 86400; // 24h
		this.signedUrlCacheExpireTimeSeconds =
			config.signedUrlCacheExpireTimeSeconds ?? 82800; // 22h

		this.minimumMultipartUploadSize =
			config.minimumMultipartUploadSize ?? 5 * 1024 * 1024; // 5 MB
		this.defaultMultipartUploadSize =
			config.defaultMultipartUploadSize ?? 10 * 1024 * 1024; // 5 MB
		this.maxFileSize = config.maxSize ?? 52428800;
		this.bucket = config.bucket;
		this.client = new S3Client(this.config);

		// Memoize expects maxAge in MS and s3 signing method in seconds.
		// Normalization to use only seconds and therefore convert here from seconds to MS
		this.cachedGetSignedUrl = memoize(this.s3SignUrl, {
			maxAge: this.signedUrlCacheExpireTimeSeconds * 1000,
		});
		this.storageClass = config.storageClass ?? 'INTELLIGENT_TIERING';
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
			ContentDisposition: `inline; filename=${resource.originalname}`,
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
		} catch (err: any) {
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

	public multipartUpload = {
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
					ContentDisposition: `inline; ${payload.filename}`,
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
		return `${this.config.endpoint}/${this.bucket}/${key}`;
	}

	private getKeyFromHref(href: string): string {
		const hrefWithoutParams = normalizeHref(href);
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

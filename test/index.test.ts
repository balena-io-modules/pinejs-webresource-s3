import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import sinon, { type SinonStub } from 'sinon';
import {
	S3Client,
	DeleteObjectCommand,
	GetObjectCommand,
	CreateMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	HeadObjectCommand,
	AbortMultipartUploadCommand,
	PutObjectCommand,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Handler } from '../lib/index.ts';
import { PassThrough } from 'stream';
import { inspect } from 'util';
import { Upload } from '@aws-sdk/lib-storage';
import type { webResourceHandler } from '@balena/pinejs';

chai.use(chaiAsPromised);
const s3Mock = mockClient(S3Client);

const { expect } = chai;

describe('S3Handler', function () {
	let s3Handler: S3Handler;
	const clientMaxSize = 1024 * 1024;

	beforeEach(() => {
		s3Mock.reset();
		s3Handler = new S3Handler({
			region: 'us-east-1',
			accessKey: 'test-access-key',
			secretKey: 'test-secret-key',
			endpoint: 'https://s3.test.com',
			bucket: 'test-bucket',
			maxSize: clientMaxSize,
		});
	});

	describe('constructor', function () {
		const requiredProps = {
			region: 'us-east-1',
			accessKey: 'test-access-key',
			secretKey: 'test-secret-key',
			endpoint: 'https://s3.test.com',
			bucket: 'test-bucket',
		};

		const invalidConfigs: Array<
			[
				props: Partial<ConstructorParameters<typeof S3Handler>[0]>,
				message: string,
			]
		> = [
			[
				{ signedUrlExpireTimeSeconds: 7 * 24 * 60 * 60 + 1 },
				'signedUrlExpireTimeSeconds must be an integer between 1 and 604800',
			],
			[
				{ signedUrlExpireTimeSeconds: 0 },
				'signedUrlExpireTimeSeconds must be an integer between 1 and 604800',
			],
			[
				{
					signedUrlExpireTimeSeconds: 3600,
					signedUrlCacheExpireTimeSeconds: 3600,
				},
				'signedUrlCacheExpireTimeSeconds must be at least 0 and less than signedUrlExpireTimeSeconds',
			],
			[
				{ signedUrlCacheExpireTimeSeconds: -1 },
				'signedUrlCacheExpireTimeSeconds must be at least 0 and less than signedUrlExpireTimeSeconds',
			],
			[
				{ minimumMultipartUploadSize: 0 },
				'minimumMultipartUploadSize must be a positive integer',
			],
			[
				{ defaultMultipartUploadSize: 1024 },
				'defaultMultipartUploadSize must be an integer of at least minimumMultipartUploadSize',
			],
			[{ maxSize: NaN }, 'maxSize must be a number of at least 0'],
		];
		for (const [props, message] of invalidConfigs) {
			it(`should reject ${inspect(props, { breakLength: Infinity })}`, function () {
				expect(() => new S3Handler({ ...requiredProps, ...props })).to.throw(
					message,
				);
			});
		}

		it('should accept the limits of the valid ranges', function () {
			expect(
				() =>
					new S3Handler({
						...requiredProps,
						signedUrlExpireTimeSeconds: 7 * 24 * 60 * 60,
						signedUrlCacheExpireTimeSeconds: 0,
						minimumMultipartUploadSize: 1,
						defaultMultipartUploadSize: 1,
						maxSize: 0,
					}),
			).to.not.throw();
		});
	});

	describe('handleFile', function () {
		let uploadStub: SinonStub;

		beforeEach(function () {
			uploadStub = sinon.stub(Upload.prototype, 'done').resolves();
		});

		afterEach(function () {
			uploadStub.restore();
		});

		it('should upload a file and return the correct response', async function () {
			const stream = new PassThrough();
			const resource = {
				fieldname: 'test',
				originalname: 'file.txt',
				stream,
				mimetype: 'text/plain',
				encoding: 'utf-8',
			};

			const result = await s3Handler.handleFile(resource);

			expect(result).to.have.property('size');
			expect(result).to.have.property('filename');
		});

		it('should throw an error when file exceeds maxFileSize', async function () {
			uploadStub.restore();
			uploadStub = sinon.stub(Upload.prototype, 'done').callsFake(function (
				this: Upload,
			) {
				this.emit('httpUploadProgress', { total: clientMaxSize + 1 });
				throw new Error('Upload aborted due to file size limit');
			});

			const stream = new PassThrough();
			const resource = {
				fieldname: 'test',
				originalname: 'large-file.txt',
				stream,
				mimetype: 'text/plain',
				encoding: 'utf-8',
			};

			await expect(s3Handler.handleFile(resource)).to.be.rejectedWith(
				'File size exceeded the limit of 1048576 bytes.',
			);
		});

		it('should handle upload failures and throw an error', async function () {
			uploadStub.restore();
			uploadStub = sinon.stub(Upload.prototype, 'done').callsFake(function () {
				throw new Error('S3 upload failed');
			});

			const stream = new PassThrough();
			const resource = {
				fieldname: 'test',
				originalname: 'error-file.txt',
				stream,
				mimetype: 'text/plain',
				encoding: 'utf-8',
			};

			await expect(s3Handler.handleFile(resource)).to.be.rejectedWith(
				'S3 upload failed',
			);
		});
	});

	describe('removeFile', function () {
		it('should remove a file from S3', async function () {
			s3Mock.on(DeleteObjectCommand).resolves({});
			await s3Handler.removeFile('https://s3.test.com/test-bucket/file.txt');
			expect(s3Mock.calls()).to.have.lengthOf(1);
			expect(s3Mock.calls()[0].firstArg).to.be.instanceOf(DeleteObjectCommand);
			expect(s3Mock.calls()[0].firstArg.input).to.deep.equal({
				Bucket: 'test-bucket',
				Key: 'file.txt',
			});
		});
	});

	describe('onPreRespond', function () {
		it('should replace href with a signed URL', async function () {
			s3Mock.on(GetObjectCommand).resolves({});
			const webResource = {
				href: 'https://s3.test.com/test-bucket/file.txt',
				filename: 'file.txt',
			};
			const result = await s3Handler.onPreRespond(webResource);
			expect(result.href).to.be.a('string');
			// X-Amz-Signature should be present in the signed URL
			expect(result.href).to.match(/X-Amz-Signature=/);
		});

		describe('signed url cache', function () {
			let signStub: SinonStub;

			beforeEach(function () {
				// Stubbed before constructing as the handler memoizes the method itself
				signStub = sinon
					.stub(S3Handler.prototype as any, 's3SignUrl')
					.callsFake((fileKey) =>
						Promise.resolve(`https://signed.test.com/${fileKey as string}`),
					);
			});

			afterEach(function () {
				signStub.restore();
			});

			const handlerWithCacheTime = (signedUrlCacheExpireTimeSeconds?: number) =>
				new S3Handler({
					region: 'us-east-1',
					accessKey: 'test-access-key',
					secretKey: 'test-secret-key',
					endpoint: 'https://s3.test.com',
					bucket: 'test-bucket',
					signedUrlCacheExpireTimeSeconds,
				});
			const webResource = (filename = 'file.txt') => ({
				href: `https://s3.test.com/test-bucket/${filename}`,
				filename,
			});

			it('should reuse a signed url for the same file', async function () {
				const cachingS3Handler = handlerWithCacheTime();

				await cachingS3Handler.onPreRespond(webResource());
				const result = await cachingS3Handler.onPreRespond(webResource());

				expect(result.href).to.equal('https://signed.test.com/file.txt');
				expect(signStub.callCount).to.equal(1);
			});

			it('should sign every time when the cache time is 0', async function () {
				const uncachedS3Handler = handlerWithCacheTime(0);

				await uncachedS3Handler.onPreRespond(webResource());
				const result = await uncachedS3Handler.onPreRespond(webResource());

				expect(result.href).to.equal('https://signed.test.com/file.txt');
				expect(signStub.callCount).to.equal(2);
			});

			it('should not cache a failed signing', async function () {
				const cachingS3Handler = handlerWithCacheTime();
				signStub.onFirstCall().rejects(new Error('Transient signing failure'));

				await expect(
					cachingS3Handler.onPreRespond(webResource()),
				).to.be.rejectedWith('Transient signing failure');
				// memoizee evicts a rejection on the next tick, ie before any later request
				await new Promise((resolve) => setImmediate(resolve));
				const result = await cachingS3Handler.onPreRespond(webResource());

				expect(result.href).to.equal('https://signed.test.com/file.txt');
				expect(signStub.callCount).to.equal(2);
			});

			it('should evict the least recently used url past signedUrlCacheMaxEntries', async function () {
				const limitedS3Handler = new S3Handler({
					region: 'us-east-1',
					accessKey: 'test-access-key',
					secretKey: 'test-secret-key',
					endpoint: 'https://s3.test.com',
					bucket: 'test-bucket',
					signedUrlCacheMaxEntries: 2,
				});

				for (const filename of ['a', 'b', 'c']) {
					await limitedS3Handler.onPreRespond(webResource(filename));
					// memoizee only records a resolved url, and so evicts, on the next tick
					await new Promise((resolve) => setImmediate(resolve));
				}
				expect(signStub.callCount).to.equal(3);

				// 'c' is still cached whilst 'a' was evicted to make room for it
				await limitedS3Handler.onPreRespond(webResource('c'));
				await new Promise((resolve) => setImmediate(resolve));
				expect(signStub.callCount).to.equal(3);
				const result = await limitedS3Handler.onPreRespond(webResource('a'));
				expect(signStub.callCount).to.equal(4);
				expect(result.href).to.equal('https://signed.test.com/a');
			});
		});
	});

	describe('Content-Disposition', function () {
		const cases: Array<[filename: string, contentDisposition: string]> = [
			['file.txt', 'inline; filename="file.txt"'],
			[
				'naïve.txt',
				`inline; filename="na_ve.txt"; filename*=UTF-8''na%C3%AFve.txt`,
			],
			[
				'文件.txt',
				`inline; filename="__.txt"; filename*=UTF-8''%E6%96%87%E4%BB%B6.txt`,
			],
			[
				'a"; filename="evil.exe',
				`inline; filename="a_; filename=_evil.exe"; filename*=UTF-8''a%22%3B%20filename%3D%22evil.exe`,
			],
			[
				'back\\slash.txt',
				`inline; filename="back_slash.txt"; filename*=UTF-8''back%5Cslash.txt`,
			],
		];

		for (const [filename, contentDisposition] of cases) {
			it(`should send an ASCII header for ${JSON.stringify(filename)} in handleFile`, async function () {
				s3Mock.on(PutObjectCommand).resolves({});
				const stream = new PassThrough();
				stream.end('content');

				await s3Handler.handleFile({
					fieldname: 'test',
					originalname: filename,
					stream,
					mimetype: 'text/plain',
					encoding: '7bit',
				});

				const [putCall] = s3Mock.commandCalls(PutObjectCommand);
				expect(putCall.args[0].input.ContentDisposition)
					.to.equal(contentDisposition)
					.and.to.match(/^[\x20-\x7e]*$/);
			});

			it(`should send an ASCII header for ${JSON.stringify(filename)} in multipartUpload.begin`, async function () {
				s3Mock
					.on(CreateMultipartUploadCommand)
					.resolves({ UploadId: 'test-upload-id' });

				await s3Handler.multipartUpload.begin('test', {
					filename,
					content_type: 'text/plain',
					size: 1024,
					chunk_size: 1024,
				});

				const [createCall] = s3Mock.commandCalls(CreateMultipartUploadCommand);
				expect(createCall.args[0].input.ContentDisposition)
					.to.equal(contentDisposition)
					.and.to.match(/^[\x20-\x7e]*$/);
			});
		}
	});

	describe('multipartUpload', function () {
		describe('begin', function () {
			function testMultipartUpload(
				payload: webResourceHandler.BeginMultipartUploadPayload,
				expectedParts: Array<{ chunkSize: number; partNumber: number }>,
			) {
				return async function () {
					s3Mock
						.on(CreateMultipartUploadCommand)
						.resolves({ UploadId: 'test-upload-id' });
					const result = await s3Handler.multipartUpload.begin('test', payload);

					expect(result).to.have.property('fileKey');
					expect(result).to.have.property('uploadId', 'test-upload-id');
					expect(result.uploadParts)
						.to.be.an('array')
						.with.lengthOf(expectedParts.length);

					expectedParts.forEach((part, index: number) => {
						expect(result.uploadParts[index]).to.have.property(
							'chunkSize',
							part.chunkSize,
						);
						expect(result.uploadParts[index]).to.have.property(
							'partNumber',
							part.partNumber,
						);
						expect(result.uploadParts[index])
							.to.have.property('url')
							.that.matches(/X-Amz-Signature=/);
					});

					expect(s3Mock.calls()).to.have.lengthOf(1);
					expect(s3Mock.calls()[0].firstArg).to.be.instanceOf(
						CreateMultipartUploadCommand,
					);

					expect(s3Mock.calls()[0].firstArg.input.Bucket).to.be.equal(
						'test-bucket',
					);
					expect(s3Mock.calls()[0].firstArg.input.ContentType).to.be.equal(
						'text/plain',
					);
					expect(s3Mock.calls()[0].firstArg.input.Key).to.match(
						new RegExp(`test_[0-9a-f-]+`),
					);
				};
			}

			it(
				'should initiate a multipart upload',
				testMultipartUpload(
					{
						filename: 'file.txt',
						content_type: 'text/plain',
						size: 1024,
						chunk_size: 512,
					},
					[
						{ chunkSize: 512, partNumber: 1 },
						{ chunkSize: 512, partNumber: 2 },
					],
				),
			);

			it(
				'should handle a single part upload',
				testMultipartUpload(
					{
						filename: 'file.txt',
						content_type: 'text/plain',
						size: 1024,
						chunk_size: 1024,
					},
					[{ chunkSize: 1024, partNumber: 1 }],
				),
			);

			it(
				'should handle a single part upload with chunk size greater than file size',
				testMultipartUpload(
					{
						filename: 'file.txt',
						content_type: 'text/plain',
						size: 1024,
						chunk_size: 2048,
					},
					[{ chunkSize: 1024, partNumber: 1 }],
				),
			);

			it(
				'should handle a not divisible chunk size',
				testMultipartUpload(
					{
						filename: 'file.txt',
						content_type: 'text/plain',
						size: 1024,
						chunk_size: 513,
					},
					[
						{ chunkSize: 513, partNumber: 1 },
						{ chunkSize: 511, partNumber: 2 },
					],
				),
			);

			it('should throw an error when the multipart upload fails', async function () {
				s3Mock.on(CreateMultipartUploadCommand).resolves({});

				const payload = {
					filename: 'file.txt',
					content_type: 'text/plain',
					size: 1024,
					chunk_size: 512,
				};
				await expect(
					s3Handler.multipartUpload.begin('test', payload),
				).to.be.rejectedWith('Failed to create multipart upload.');

				expect(s3Mock.calls()).to.have.lengthOf(1);
				expect(s3Mock.calls()[0].firstArg).to.be.instanceOf(
					CreateMultipartUploadCommand,
				);

				expect(s3Mock.calls()[0].firstArg.input.Bucket).to.be.equal(
					'test-bucket',
				);
				expect(s3Mock.calls()[0].firstArg.input.ContentType).to.be.equal(
					'text/plain',
				);
				expect(s3Mock.calls()[0].firstArg.input.Key).to.match(
					new RegExp(`test_[0-9a-f-]+`),
				);
			});
		});

		describe('commit', function () {
			it('should complete a multipart upload', async function () {
				s3Mock.on(CompleteMultipartUploadCommand).resolves({});
				s3Mock
					.on(HeadObjectCommand)
					.resolves({ ContentLength: 1024, ContentType: 'text/plain' });

				const payload = {
					fileKey: 'test-key',
					uploadId: 'test-upload-id',
					filename: 'file.txt',
					providerCommitData: {},
				};
				const result = await s3Handler.multipartUpload.commit(payload);

				expect(result).to.have.property('href');
				expect(result).to.have.property('size', 1024);
				expect(result).to.have.property('content_type', 'text/plain');

				expect(s3Mock.calls()).to.have.lengthOf(2);
				expect(s3Mock.calls()[0].firstArg).to.be.instanceOf(
					CompleteMultipartUploadCommand,
				);

				expect(s3Mock.calls()[0].firstArg.input).to.deep.equal({
					Bucket: 'test-bucket',
					Key: 'test-key',
					UploadId: 'test-upload-id',
					MultipartUpload: {},
				});
			});
		});

		describe('cancel', function () {
			it('should abort a multipart upload', async function () {
				s3Mock.on(AbortMultipartUploadCommand).resolves({});

				const payload = {
					fileKey: 'test-key',
					uploadId: 'test-upload-id',
				};

				await s3Handler.multipartUpload.cancel(payload);

				expect(s3Mock.calls()).to.have.lengthOf(1);
				expect(s3Mock.calls()[0].firstArg).to.be.instanceOf(
					AbortMultipartUploadCommand,
				);

				expect(s3Mock.calls()[0].firstArg.input).to.deep.equal({
					Bucket: 'test-bucket',
					Key: 'test-key',
					UploadId: 'test-upload-id',
				});
			});

			it('should throw an error when aborting fails', async function () {
				s3Mock.on(AbortMultipartUploadCommand).rejects(new Error('S3 error'));

				const payload = {
					fileKey: 'test-key',
					uploadId: 'test-upload-id',
				};

				await expect(
					s3Handler.multipartUpload.cancel(payload),
				).to.be.rejectedWith('S3 error');

				expect(s3Mock.calls()).to.have.lengthOf(1);
				expect(s3Mock.calls()[0].firstArg).to.be.instanceOf(
					AbortMultipartUploadCommand,
				);
			});
		});
	});
});

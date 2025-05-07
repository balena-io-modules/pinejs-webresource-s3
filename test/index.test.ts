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
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Handler } from '../lib/index.js';
import { PassThrough } from 'stream';
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
});

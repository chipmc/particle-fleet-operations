/**
 * S3 utilities for fetching raw event data
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { S3StorageRecord } from '../types';

/**
 * Create S3 client with specified AWS profile
 */
export function createS3Client(profile: string): S3Client {
  process.env.AWS_PROFILE = profile;
  return new S3Client({});
}

/**
 * Fetch raw event data from S3
 * 
 * @param bucketName - S3 bucket name
 * @param s3Key - S3 object key
 * @param profile - AWS profile to use
 * @returns Parsed S3 storage record
 */
export async function fetchRawEvent(
  bucketName: string,
  s3Key: string,
  profile: string = 'particle-admin'
): Promise<S3StorageRecord> {
  const s3 = createS3Client(profile);
  
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: s3Key,
  });
  
  const response = await s3.send(command);
  
  if (!response.Body) {
    throw new Error(`No data found at s3://${bucketName}/${s3Key}`);
  }
  
  const bodyString = await response.Body.transformToString();
  return JSON.parse(bodyString) as S3StorageRecord;
}

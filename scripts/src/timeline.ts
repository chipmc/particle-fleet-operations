#!/usr/bin/env node

/**
 * Device Timeline Inspector
 * 
 * Local read-only CLI tool for querying device event timelines from DynamoDB.
 * 
 * Features:
 * - Query by deviceId
 * - Optional time range filtering
 * - Display chronological events
 * - Fetch raw S3 event data on demand
 * 
 * Usage:
 *   npm run timeline -- --deviceId <deviceId> --hours 24
 *   npm run timeline -- --deviceId <deviceId> --start <ISO8601> --end <ISO8601>
 *   npm run timeline -- --deviceId <deviceId> --hours 24 --show-raw
 */

import { Command } from 'commander';
import { queryDeviceTimeline, hoursAgo } from './lib/dynamo-query';
import { fetchRawEvent } from './lib/s3-fetch';
import { formatTimelineHeader, formatTimelineEvent, formatRawEvent, formatError } from './lib/formatters';

const program = new Command();

program
  .name('timeline')
  .description('Inspect device event timeline from DynamoDB')
  .version('1.0.0')
  .requiredOption('-d, --deviceId <deviceId>', 'Device ID to query')
  .option('-h, --hours <hours>', 'Number of hours to look back', '24')
  .option('-s, --start <ISO8601>', 'Start time (ISO 8601 format)')
  .option('-e, --end <ISO8601>', 'End time (ISO 8601 format)')
  .option('-l, --limit <number>', 'Maximum number of events to return', '100')
  .option('-r, --show-raw [index]', 'Show raw S3 event data (optionally specify event index, default: all)')
  .option('-p, --profile <profile>', 'AWS profile to use', 'particle-admin')
  .option('-t, --table <tableName>', 'DynamoDB table name (defaults to CloudFormation output)')
  .option('-b, --bucket <bucketName>', 'S3 bucket name (defaults to CloudFormation output)')
  .parse(process.argv);

const options = program.opts();

/**
 * Get AWS resource names from environment or CloudFormation outputs
 */
async function getResourceNames(): Promise<{ tableName: string; bucketName: string }> {
  // Try environment variables first
  if (process.env.LOG_EVENTS_TABLE_NAME && process.env.RAW_LOGS_BUCKET_NAME) {
    return {
      tableName: process.env.LOG_EVENTS_TABLE_NAME,
      bucketName: process.env.RAW_LOGS_BUCKET_NAME,
    };
  }
  
  // Use provided options if available
  if (options.table && options.bucket) {
    return {
      tableName: options.table,
      bucketName: options.bucket,
    };
  }
  
  // Try to get from CloudFormation stack outputs
  try {
    const { CloudFormationClient, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');
    process.env.AWS_PROFILE = options.profile;
    const cfn = new CloudFormationClient({});
    
    const response = await cfn.send(new DescribeStacksCommand({
      StackName: 'InfraStack',
    }));
    
    const outputs = response.Stacks?.[0]?.Outputs || [];
    const tableName = outputs.find((o: any) => o.OutputKey === 'LogEventsTableName')?.OutputValue;
    const bucketName = outputs.find((o: any) => o.OutputKey === 'RawLogsBucketName')?.OutputValue;
    
    if (!tableName || !bucketName) {
      throw new Error('Could not find table or bucket name in CloudFormation outputs');
    }
    
    return { tableName, bucketName };
  } catch (error) {
    console.error(formatError(
      'Could not determine AWS resource names. Please specify --table and --bucket, or set environment variables.',
      error as Error
    ));
    process.exit(1);
  }
}

/**
 * Main execution
 */
async function main() {
  try {
    const { tableName, bucketName } = await getResourceNames();
    
    // Calculate time range
    let startTime: string | undefined;
    let endTime: string | undefined;
    
    if (options.start && options.end) {
      startTime = options.start;
      endTime = options.end;
    } else if (options.start) {
      startTime = options.start;
      endTime = new Date().toISOString();
    } else if (options.hours) {
      startTime = hoursAgo(parseInt(options.hours, 10));
      endTime = new Date().toISOString();
    }
    
    // Query timeline
    const events = await queryDeviceTimeline(
      tableName,
      {
        deviceId: options.deviceId,
        startTime,
        endTime,
        limit: parseInt(options.limit, 10),
      },
      options.profile
    );
    
    // Display timeline header
    console.log(formatTimelineHeader(options.deviceId, events.length, startTime, endTime));
    
    if (events.length === 0) {
      console.log('\nNo events found for this device in the specified time range.');
      return;
    }
    
    // Display events
    for (let i = 0; i < events.length; i++) {
      console.log(formatTimelineEvent(events[i], i));
      
      // Show raw event if requested
      if (options.showRaw !== undefined) {
        const shouldShowRaw = 
          options.showRaw === true || // --show-raw without value (show all)
          (typeof options.showRaw === 'string' && parseInt(options.showRaw, 10) === i + 1); // --show-raw N
        
        if (shouldShowRaw) {
          try {
            const rawEvent = await fetchRawEvent(bucketName, events[i].s3Key, options.profile);
            console.log(formatRawEvent(rawEvent));
          } catch (error) {
            console.error(formatError(`Failed to fetch raw event from S3`, error as Error));
          }
        }
      }
    }
    
    console.log('\n');
    
  } catch (error) {
    console.error(formatError('Timeline query failed', error as Error));
    process.exit(1);
  }
}

// Execute
main();

"use strict";
/**
 * S3 storage operations for raw event archival
 *
 * Preserves exact current behavior:
 * - Immutable raw event storage
 * - JSON format with particle + parsed structure
 * - Date-partitioned key structure
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.s3 = void 0;
exports.storeRawEvent = storeRawEvent;
const client_s3_1 = require("@aws-sdk/client-s3");
// Initialize client at module level to allow mocking
const s3 = new client_s3_1.S3Client({});
exports.s3 = s3;
/**
 * Store raw event in S3
 *
 * Preserves exact current structure:
 * {
 *   "particle": <original webhook body>,
 *   "parsed": <safe record>
 * }
 *
 * @param bucketName - S3 bucket name from environment
 * @param key - S3 object key (date-partitioned path)
 * @param particle - Original Particle webhook body
 * @param parsed - Parsed event record
 */
async function storeRawEvent(bucketName, key, particle, parsed) {
    const record = {
        particle,
        parsed,
    };
    await s3.send(new client_s3_1.PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: JSON.stringify(record, null, 2),
        ContentType: 'application/json',
    }));
}
//# sourceMappingURL=s3.js.map
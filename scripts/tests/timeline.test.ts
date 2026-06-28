/**
 * Tests for timeline CLI tool utilities
 */

import { hoursAgo } from '../src/lib/dynamo-query';

describe('Timeline Utilities', () => {
  describe('hoursAgo', () => {
    it('should calculate time hours ago', () => {
      const now = new Date();
      const result = hoursAgo(24);
      const parsed = new Date(result);
      
      const hoursDiff = Math.abs(now.getTime() - parsed.getTime()) / (1000 * 60 * 60);
      
      // Should be approximately 24 hours (within 1 second tolerance)
      expect(hoursDiff).toBeGreaterThan(23.99);
      expect(hoursDiff).toBeLessThan(24.01);
    });
    
    it('should return ISO 8601 format', () => {
      const result = hoursAgo(12);
      
      // Should match ISO 8601 format
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });
});

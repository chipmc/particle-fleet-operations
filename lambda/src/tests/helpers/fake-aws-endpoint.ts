/**
 * A local stand-in for API Gateway and SNS that speaks their real wire formats, so tests go
 * through the real AWS SDK serializers and deserializers instead of a hand-written mock of
 * the SDK's output (STYLE_GUIDE §5: a mock must match the real service).
 *
 * - API Gateway (REST-JSON): `GET /apikeys` returns `{"item": [...], "position": "..."}` with
 *   epoch-second timestamps. Confirmed by replay through @aws-sdk/client-api-gateway that the
 *   SDK maps wire `item` to `items` and parses `createdDate` to a Date; a body using `items`
 *   deserializes to nothing.
 * - SNS (AWS Query): `POST /` with a form-encoded `Action=Publish`, answered in XML.
 *
 * `awsEnvFor()` points every SDK client at this server (service-specific and global
 * AWS_ENDPOINT_URL variables, as read by @smithy/core) with dummy credentials, so a request
 * the test didn't anticipate fails here instead of reaching AWS.
 */
import * as http from 'http';
import { AddressInfo } from 'net';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly form: Record<string, string>;
}

export interface WireResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
}

export interface FakeAwsEndpoint {
  readonly url: string;
  readonly requests: RecordedRequest[];
  /** Answer for each `GET /apikeys`, given its query. Default: one empty page. */
  getApiKeys: (query: Record<string, string>) => WireResponse;
  /** Answer for each SNS Publish, given its form fields. Default: success. */
  publish: (form: Record<string, string>) => WireResponse;
  close(): Promise<void>;
}

export interface WireKey {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly enabled?: unknown;
  /** Epoch seconds on the wire, as API Gateway sends it. */
  readonly createdDate?: unknown;
  readonly [extra: string]: unknown;
}

export function apiKeysPage(items: readonly WireKey[], position?: string): WireResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(position === undefined ? { item: items } : { item: items, position }),
  };
}

export function epochSeconds(iso: string): number {
  return Date.parse(iso) / 1000;
}

export const PUBLISH_OK: WireResponse = {
  status: 200,
  headers: { 'content-type': 'text/xml' },
  body: '<PublishResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><PublishResult><MessageId>m-1</MessageId></PublishResult><ResponseMetadata><RequestId>r-1</RequestId></ResponseMetadata></PublishResponse>',
};

export async function startFakeAwsEndpoint(): Promise<FakeAwsEndpoint> {
  const requests: RecordedRequest[] = [];
  const fake: Omit<FakeAwsEndpoint, 'url' | 'close'> = {
    requests,
    getApiKeys: () => apiKeysPage([]),
    publish: () => PUBLISH_OK,
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const query = Object.fromEntries(url.searchParams);
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      requests.push({ method: req.method ?? '', path: url.pathname, query, form });
      let reply: WireResponse;
      if (req.method === 'GET' && url.pathname === '/apikeys') reply = fake.getApiKeys(query);
      else if (req.method === 'POST' && form.Action === 'Publish') reply = fake.publish(form);
      else reply = { status: 400, headers: { 'content-type': 'application/json' }, body: '{"message":"unexpected request in test"}' };
      res.writeHead(reply.status, reply.headers ?? {});
      res.end(reply.body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const endpoint = fake as FakeAwsEndpoint;
  (endpoint as { url: string }).url = `http://127.0.0.1:${port}`;
  endpoint.close = () => new Promise<void>(resolve => server.close(() => resolve()));
  return endpoint;
}

/** Environment that routes every AWS SDK client to `url` with dummy credentials. */
export function awsEnvFor(url: string): Record<string, string> {
  return {
    AWS_ENDPOINT_URL: url,
    AWS_ENDPOINT_URL_API_GATEWAY: url,
    AWS_ENDPOINT_URL_SNS: url,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'fake-endpoint-test-access-key',
    AWS_SECRET_ACCESS_KEY: 'fake-endpoint-test-secret',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_CONFIG_FILE: '/nonexistent/aws-config',
    AWS_SHARED_CREDENTIALS_FILE: '/nonexistent/aws-credentials',
  };
}

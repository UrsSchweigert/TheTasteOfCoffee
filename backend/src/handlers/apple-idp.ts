// Deploy-time custom resource for the Sign in with Apple provider (ADR 0015). Runs
// only when CloudFormation creates, updates or deletes the resource; the logic is in
// src/apple-idp/provider.ts. The response goes to CloudFormation's presigned S3 URL.
// One log line per event: request type, status and reason (an error class name).
// Never the key, the properties or the response URL.
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { SSMClient } from '@aws-sdk/client-ssm';
import { CustomResourceEventSchema, handleAppleProvider } from '../apple-idp/provider.ts';
import type { AppleProviderDeps, CustomResourceResponse } from '../apple-idp/provider.ts';

export type SendResponse = (url: string, response: CustomResourceResponse) => Promise<void>;

/** PUT to the presigned URL. Content-Type empty, as CloudFormation's own helper sends it. */
export const sendResponse: SendResponse = async (url, response) => {
  const body = JSON.stringify(response);
  const result = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': '', 'content-length': String(Buffer.byteLength(body)) },
    body,
  });
  if (!result.ok) throw new Error(`response upload failed with HTTP ${String(result.status)}`);
};

let defaultDeps: AppleProviderDeps | undefined;

export async function run(event: unknown, deps: AppleProviderDeps, send: SendResponse): Promise<void> {
  const parsed = CustomResourceEventSchema.safeParse(event);
  if (!parsed.success) {
    // Without a valid ResponseURL there is nobody to answer.
    console.log(JSON.stringify({ operation: 'apple-idp', status: 'FAILED', reason: 'InvalidEvent' }));
    return;
  }
  const response = await handleAppleProvider(parsed.data, deps);
  console.log(
    JSON.stringify({ operation: 'apple-idp', request: parsed.data.RequestType, status: response.Status, reason: response.Reason }),
  );
  try {
    await send(parsed.data.ResponseURL, response);
  } catch {
    // CloudFormation then waits for its timeout; the log line says why.
    console.log(JSON.stringify({ operation: 'apple-idp', status: 'FAILED', reason: 'ResponseUploadFailed' }));
  }
}

export async function handler(event: unknown): Promise<void> {
  defaultDeps ??= { cognito: new CognitoIdentityProviderClient({}), ssm: new SSMClient({}) };
  await run(event, defaultDeps, sendResponse);
}

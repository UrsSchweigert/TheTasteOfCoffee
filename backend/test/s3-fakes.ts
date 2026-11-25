// Test doubles for account deletion (M1-T6): a versioned S3 bucket that
// answers the commands the deletion code sends (ListObjectVersions with
// pagination, DeleteObject by VersionId, PutObject) and a Cognito client that
// answers AdminDeleteUser. Nothing here reaches AWS.
import { AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DeleteObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

export interface StoredVersion {
  readonly versionId: string;
  /** A delete marker has no body. */
  readonly deleteMarker: boolean;
  readonly body?: string;
  readonly contentType?: string;
}

export interface SentCommand {
  readonly name: 'ListObjectVersions' | 'DeleteObject' | 'PutObject' | 'other';
  readonly input: Record<string, unknown>;
}

export function awsError(name: string): Error {
  return Object.assign(new Error('the service said no'), { name });
}

/**
 * One versioned bucket per instance, keyed by object key. ListObjectVersions
 * returns keys in order with their versions newest first, `pageSize` entries
 * (versions and markers together) per page, like S3's MaxKeys.
 */
export class VersionedBucket {
  public readonly objects = new Map<string, StoredVersion[]>();
  public readonly sent: SentCommand[] = [];
  /** Shared journal, for ordering assertions across fakes; entries are `<label>:<command>`. */
  public journal: string[] | undefined;
  public label = 's3';
  /** If set, called before each command; a returned error is thrown. */
  public failWith: ((command: SentCommand) => Error | undefined) | undefined;
  #next = 0;

  public readonly bucket: string;
  public readonly pageSize: number;

  public constructor(bucket: string, pageSize = 1000) {
    this.bucket = bucket;
    this.pageSize = pageSize;
  }

  /** Adds a version (or a delete marker) of `key`, as a PutObject or a plain DeleteObject would. */
  public put(key: string, body = 'bytes', deleteMarker = false): string {
    this.#next += 1;
    const versionId = `v${String(this.#next).padStart(6, '0')}`;
    const versions = this.objects.get(key) ?? [];
    versions.unshift({ versionId, deleteMarker, ...(deleteMarker ? {} : { body }) });
    this.objects.set(key, versions);
    return versionId;
  }

  /** Every key that still has a version or a delete marker. */
  public keys(): string[] {
    return [...this.objects].filter(([, versions]) => versions.length > 0).map(([key]) => key).sort();
  }

  public get client(): S3Client {
    return { send: (command: unknown) => this.#send(command) } as unknown as S3Client;
  }

  #send(command: unknown): Promise<unknown> {
    const input = (command as { input: Record<string, unknown> }).input;
    const name =
      command instanceof ListObjectVersionsCommand
        ? 'ListObjectVersions'
        : command instanceof DeleteObjectCommand
          ? 'DeleteObject'
          : command instanceof PutObjectCommand
            ? 'PutObject'
            : 'other';
    const sent: SentCommand = { name, input };
    this.sent.push(sent);
    this.journal?.push(`${this.label}:${name}`);
    const failure = this.failWith?.(sent);
    if (failure !== undefined) return Promise.reject(failure);
    if (input.Bucket !== this.bucket) return Promise.reject(awsError('NoSuchBucket'));
    switch (name) {
      case 'ListObjectVersions':
        return Promise.resolve(this.#list(input));
      case 'DeleteObject': {
        const key = String(input.Key);
        const versionId = input.VersionId;
        if (typeof versionId !== 'string') {
          // A plain delete on a versioned bucket only adds a marker; the deletion code must never do this.
          this.put(key, '', true);
          return Promise.resolve({ DeleteMarker: true });
        }
        const versions = this.objects.get(key) ?? [];
        this.objects.set(
          key,
          versions.filter((version) => version.versionId !== versionId),
        );
        return Promise.resolve({ VersionId: versionId });
      }
      case 'PutObject': {
        const key = String(input.Key);
        const versionId = this.put(key, String(input.Body));
        const versions = this.objects.get(key) ?? [];
        const first = versions[0];
        if (first !== undefined) versions[0] = { ...first, ...(typeof input.ContentType === 'string' ? { contentType: input.ContentType } : {}) };
        return Promise.resolve({ VersionId: versionId });
      }
      default:
        return Promise.reject(new Error('unexpected command'));
    }
  }

  #list(input: Record<string, unknown>): unknown {
    const prefix = typeof input.Prefix === 'string' ? input.Prefix : '';
    const entries = [...this.objects]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .flatMap(([key, versions]) => versions.map((version) => ({ key, version })));
    let start = 0;
    if (typeof input.KeyMarker === 'string') {
      const marker = entries.findIndex((entry) => entry.key === input.KeyMarker && entry.version.versionId === input.VersionIdMarker);
      start = marker + 1;
    }
    const page = entries.slice(start, start + this.pageSize);
    const truncated = start + this.pageSize < entries.length;
    const last = page.at(-1);
    return {
      Versions: page.filter((entry) => !entry.version.deleteMarker).map((entry) => ({ Key: entry.key, VersionId: entry.version.versionId })),
      DeleteMarkers: page.filter((entry) => entry.version.deleteMarker).map((entry) => ({ Key: entry.key, VersionId: entry.version.versionId })),
      IsTruncated: truncated,
      ...(truncated && last !== undefined ? { NextKeyMarker: last.key, NextVersionIdMarker: last.version.versionId } : {}),
    };
  }
}

/** A Cognito client whose pool holds `users`; AdminDeleteUser of a missing user is UserNotFoundException. */
export class FakeUserPool {
  public readonly users: Set<string>;
  public readonly sent: Record<string, unknown>[] = [];
  public journal: string[] | undefined;
  public failWith: Error | undefined;

  public readonly userPoolId: string;

  public constructor(userPoolId: string, users: string[]) {
    this.userPoolId = userPoolId;
    this.users = new Set(users);
  }

  public get client(): CognitoIdentityProviderClient {
    return {
      send: (command: unknown) => {
        if (!(command instanceof AdminDeleteUserCommand)) return Promise.reject(new Error('unexpected command'));
        const input = command.input as unknown as Record<string, unknown>;
        this.sent.push(input);
        this.journal?.push('cognito:AdminDeleteUser');
        if (this.failWith !== undefined) return Promise.reject(this.failWith);
        if (input.UserPoolId !== this.userPoolId) return Promise.reject(awsError('ResourceNotFoundException'));
        if (!this.users.delete(String(input.Username))) return Promise.reject(awsError('UserNotFoundException'));
        return Promise.resolve({});
      },
    } as unknown as CognitoIdentityProviderClient;
  }
}

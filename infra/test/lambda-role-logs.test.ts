// The Lambda roles' Logs statement must be built from the literal log group name, never
// from the log group's Arn attribute. CloudFormation resolves Fn::GetAtt LogGroup.Arn with
// logs:DescribeLogGroups, which cannot be scoped to named log groups and is therefore
// not in CupmarkCfnExecution (first dev deploy: the roles failed to create).
import { readFileSync } from 'node:fs';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { REGION, STAGES } from '../src/config.ts';
import { testApp } from './helpers.ts';

type Json = Record<string, unknown>;
interface Resource {
  readonly Type: string;
  readonly Properties: Json;
}
interface Statement {
  readonly Sid?: string;
  readonly Action: string | string[];
  readonly Resource: unknown;
}

const PARTS = ['api', 'health', 'apple-idp'] as const;

/** Every `Fn::GetAtt` below `value`, as [logical id, attribute]. */
function getAtts(value: unknown): [string, string][] {
  if (Array.isArray(value)) return value.flatMap(getAtts);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => {
    if (k === 'Fn::GetAtt' && Array.isArray(v)) return [[String(v[0]), String(v[1])] as [string, string]];
    return getAtts(v);
  });
}

describe.each(STAGES)('stage %s', (stage) => {
  const core = testApp({ context: { stage } }).stages[0]?.core;
  if (core === undefined) throw new Error(`stage ${stage} missing`);
  const resources = (Template.fromStack(core).toJSON() as { Resources: Record<string, Resource> }).Resources;
  const roles = Object.values(resources).filter((r) => r.Type === 'AWS::IAM::Role');

  it.each(PARTS)('the %s role grants log writes on the literal log group ARN, without a GetAtt', (part) => {
    const name = `cupmark-${stage}-${part}`;
    const role = roles.find((r) => r.Properties.RoleName === name);
    const policies = role?.Properties.Policies as { PolicyDocument: { Statement: Statement[] } }[];
    const logs = policies.flatMap((p) => p.PolicyDocument.Statement).filter((s) => s.Sid === 'Logs');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.Action).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
    expect(logs[0]?.Resource).toEqual({
      // The stack has a concrete env, so partition and region are literals; the account is a Ref.
      'Fn::Join': ['', [`arn:aws:logs:${REGION}:`, { Ref: 'AWS::AccountId' }, `:log-group:/aws/lambda/${name}:*`]],
    });
    expect(getAtts(logs[0]?.Resource)).toEqual([]);
    // Same shape as the old logGroupArn: the deployed ARN is arn:aws:logs:<region>:<account>:log-group:<name>:*.
    expect(`arn:aws:logs:${REGION}:123456789012:log-group:/aws/lambda/${name}:*`).toMatch(/:log-group:\/aws\/lambda\/cupmark-[a-z]+-[a-z-]+:\*$/);
  });

  it('no inline role policy refers to any attribute of a log group', () => {
    const logGroupIds = new Set(Object.entries(resources).filter(([, r]) => r.Type === 'AWS::Logs::LogGroup').map(([id]) => id));
    expect(logGroupIds.size).toBe(3);
    for (const role of roles) {
      const hits = getAtts(role.Properties.Policies).filter(([id]) => logGroupIds.has(id));
      expect(hits, String(role.Properties.RoleName)).toEqual([]);
    }
  });

  it('the log groups are unchanged: literal names, 14-day retention, used by the functions', () => {
    const groups = Object.values(resources).filter((r) => r.Type === 'AWS::Logs::LogGroup');
    expect(groups.map((g) => g.Properties.LogGroupName).sort()).toEqual(PARTS.map((p) => `/aws/lambda/cupmark-${stage}-${p}`).sort());
    for (const g of groups) expect(g.Properties.RetentionInDays).toBe(14);
  });
});

describe('the execution policy file', () => {
  it('does not grant logs:DescribeLogGroups (or a wildcard that covers it on all log groups)', () => {
    const text = readFileSync(new URL('../../scripts/aws/cupmark-cfn-execution-policy.json', import.meta.url), 'utf8');
    expect(text).not.toMatch(/DescribeLogGroups/);
    expect(text).not.toMatch(/log-group:\*"/);
  });
});

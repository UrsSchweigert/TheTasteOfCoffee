// M1-T7, ADR 0019: the Open Food Facts settings of the API function come from context,
// validated with the backend's own rules, and deploy mode (-c cupmark:deploy=<stage>)
// fails the synth unless everything a deploy needs is there. Without deploy mode a
// synth is "not for deploy" and works offline without them, as CI's does.
import { readFileSync } from 'node:fs';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { API_URL_OUTPUT } from '../src/api.ts';
import { MAX_OFF_LOOKUP_CAP, STAGES, isValidOffContact, offLookupCap } from '../src/config.ts';
import type { StageName } from '../src/config.ts';
import { checkApp } from '../src/guards.ts';
import { FAKE_ACCOUNT, readCdkJson, testApp } from './helpers.ts';

const CONTACT = 'ops@example.invalid';

function apiVariables(stage: StageName, context: Record<string, unknown> = {}): Record<string, unknown> {
  const { stages } = testApp({ context: { stage, ...context } });
  const core = stages[0]?.core;
  if (core === undefined) throw new Error('stage missing');
  const fns = Template.fromStack(core).findResources('AWS::Lambda::Function', {
    Properties: { FunctionName: `cupmark-${stage}-api` },
  });
  const fn = Object.values(fns)[0] as { Properties: { Environment: { Variables: Record<string, unknown> } } };
  return fn.Properties.Environment.Variables;
}

/** The deploy context without some keys. */
function without(stage: StageName, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(deployContext(stage)).filter(([k]) => !keys.includes(k)));
}

function deployContext(stage: StageName): Record<string, unknown> {
  return {
    stage,
    'cupmark:deploy': stage,
    [`cupmark:${stage}:account`]: FAKE_ACCOUNT,
    'cupmark:offContact': CONTACT,
  };
}

describe('Open Food Facts settings (OFF_CONTACT, OFF_LOOKUP_CAP)', () => {
  it.each(STAGES)('%s: without context the API function has neither, and the synth warns that it is not for deploy', (stage) => {
    const variables = apiVariables(stage);
    expect(variables).not.toHaveProperty('OFF_CONTACT');
    expect(variables).not.toHaveProperty('OFF_LOOKUP_CAP');
    const { stages } = testApp({ context: { stage } });
    const core = stages[0]?.core;
    if (core === undefined) throw new Error('stage missing');
    Annotations.fromStack(core).hasWarning('*', Match.stringLikeRegexp('^Not for deploy: no -c cupmark:offContact'));
  });

  it.each(STAGES)('%s: with context, only the API function gets them, as plain environment variables', (stage) => {
    const variables = apiVariables(stage, { 'cupmark:offContact': CONTACT, 'cupmark:offLookupCap': '25' });
    expect(variables.OFF_CONTACT).toBe(CONTACT);
    expect(variables.OFF_LOOKUP_CAP).toBe('25');
    const { stages } = testApp({ context: { stage, 'cupmark:offContact': CONTACT } });
    const core = stages[0]?.core;
    if (core === undefined) throw new Error('stage missing');
    const template = Template.fromStack(core);
    for (const [, fn] of Object.entries(template.findResources('AWS::Lambda::Function'))) {
      const props = (fn as { Properties: { FunctionName: string; Environment?: { Variables?: Record<string, unknown> } } }).Properties;
      if (props.FunctionName !== `cupmark-${stage}-api`) expect(props.Environment?.Variables ?? {}).not.toHaveProperty('OFF_CONTACT');
    }
    Annotations.fromStack(core).hasNoWarning('*', Match.stringLikeRegexp('Not for deploy'));
    expect(checkApp(testApp({ context: { stage, 'cupmark:offContact': CONTACT } }).app)).toEqual([]);
  });

  it('treats an empty value as not given (an unset GitHub variable)', () => {
    const variables = apiVariables('dev', { 'cupmark:offContact': '', 'cupmark:offLookupCap': '' });
    expect(variables).not.toHaveProperty('OFF_CONTACT');
    expect(variables).not.toHaveProperty('OFF_LOOKUP_CAP');
  });

  it.each([
    'not an address',
    'ops@localhost',
    'ops@example.invalid (x)',
    'ops @example.invalid',
    'ops@example.invalid\r\nX-Injected: 1',
    '"ops"@example.invalid',
    `${'a'.repeat(65)}@example.invalid`,
  ])('rejects the contact %j without echoing it', (value) => {
    expect(isValidOffContact(value)).toBe(false);
    let message = '';
    try {
      testApp({ context: { stage: 'dev', 'cupmark:offContact': value } });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('cupmark:offContact');
    expect(message).not.toContain(value);
  });

  it('accepts what the backend accepts', () => {
    for (const ok of [CONTACT, 'first.last+cupmark@mail.example.org', 'a_b%c-d@x-y.example']) expect(isValidOffContact(ok)).toBe(true);
  });

  it.each(['-1', '01', '1.5', '10001', 'fifty', ' 5'])('rejects the lookup cap %j', (value) => {
    expect(offLookupCap(value)).toBeUndefined();
    expect(() => testApp({ context: { stage: 'dev', 'cupmark:offLookupCap': value } })).toThrow(/cupmark:offLookupCap/);
  });

  it('accepts a lookup cap from 0 to 10000, as a string or a number', () => {
    expect(offLookupCap('0')).toBe('0');
    expect(offLookupCap(String(MAX_OFF_LOOKUP_CAP))).toBe('10000');
    expect(offLookupCap(50)).toBe('50');
  });

  it('keeps the contact out of the repository: cdk.json has no contact and no e-mail address', () => {
    const cdkJson = readCdkJson();
    expect(cdkJson.context).not.toHaveProperty('cupmark:offContact');
    expect(cdkJson.context).not.toHaveProperty('cupmark:deploy');
    expect(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')).not.toMatch(/@[a-z0-9-]+\./i);
  });
});

describe('deploy mode (-c cupmark:deploy=<stage>)', () => {
  it.each(STAGES)('%s: synthesises with the stage, the account and the contact, and passes every guard', (stage) => {
    const cupmark = testApp({ context: deployContext(stage) });
    expect(cupmark.stages.map((s) => s.core.stackName)).toEqual([`cupmark-${stage}-core`]);
    expect(cupmark.stages[0]?.core.account).toBe(FAKE_ACCOUNT);
    expect(cupmark.githubOidc).toBeUndefined();
    expect(checkApp(cupmark.app)).toEqual([]);
    expect(apiVariables(stage, deployContext(stage)).OFF_CONTACT).toBe(CONTACT);
  });

  it('fails without the contact (the GitHub environment variable OFF_CONTACT)', () => {
    const rest = without('dev', 'cupmark:offContact');
    expect(() => testApp({ context: rest })).toThrow(/Deploy mode for dev needs -c cupmark:offContact=/);
    expect(() => testApp({ context: { ...rest, 'cupmark:offContact': '' } })).toThrow(/needs -c cupmark:offContact=/);
  });

  it('fails without the account in context, even when CDK_DEFAULT_ACCOUNT is set', () => {
    const rest = without('dev', 'cupmark:dev:account');
    expect(() => testApp({ context: rest, env: { CDK_DEFAULT_ACCOUNT: FAKE_ACCOUNT } })).toThrow(/needs -c cupmark:dev:account=/);
    // The other stage's account does not count.
    expect(() => testApp({ context: { ...rest, 'cupmark:prod:account': FAKE_ACCOUNT } })).toThrow(/needs -c cupmark:dev:account=/);
  });

  it('fails unless -c stage= names the same stage', () => {
    const noStage = without('prod', 'stage');
    expect(() => testApp({ context: noStage })).toThrow(/Deploy mode for prod needs -c stage=prod/);
    expect(() => testApp({ context: { ...deployContext('prod'), stage: 'dev', 'cupmark:dev:account': FAKE_ACCOUNT } })).toThrow(
      /needs -c stage=prod/,
    );
  });

  it('rejects an unknown stage', () => {
    expect(() => testApp({ context: { ...deployContext('dev'), 'cupmark:deploy': 'all' } })).toThrow(/cupmark:deploy" must be one of dev, prod/);
  });
});

describe('stack outputs', () => {
  it.each(STAGES)('%s: the API URL output has the pinned key the smoke scripts read', (stage) => {
    const { stages } = testApp({ context: { stage } });
    const core = stages[0]?.core;
    if (core === undefined) throw new Error('stage missing');
    const outputs = Template.fromStack(core).toJSON().Outputs as Record<string, { Value: unknown }>;
    expect(API_URL_OUTPUT).toBe('ApiUrl');
    expect(outputs[API_URL_OUTPUT]?.Value).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^ApiHttpApi/) as unknown, 'ApiEndpoint'] });
    for (const script of ['health.sh', 'post-deploy-checks.sh']) {
      const text = readFileSync(new URL(`../../scripts/smoke/${script}`, import.meta.url), 'utf8');
      expect(text, script).toContain(`OUTPUT_KEY="${API_URL_OUTPUT}"`);
    }
  });
});

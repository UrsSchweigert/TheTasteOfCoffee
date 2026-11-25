// The real app: both stages synthesise offline, in eu-central-1, on the Cupmark
// bootstrap, with no guard violations. The table and buckets are pinned in data.test.ts,
// identity in identity.test.ts, the API in api.test.ts.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { REGION, STAGES } from '../src/config.ts';
import { ALLOWED_RESOURCE_TYPES, DENIED_RESOURCE_TYPES, checkApp, formatViolations } from '../src/guards.ts';
import { API_ROUTES } from '../src/routes.ts';
import { FAKE_ACCOUNT, INFRA_DIR, readCdkJson, testApp } from './helpers.ts';

function stacksOf(options: Parameters<typeof testApp>[0] = {}) {
  const { app, stages } = testApp(options);
  const assembly = app.synth();
  return { app, assembly, stacks: stages.map((s) => s.core) };
}

describe('the Cupmark app', () => {
  it('synthesises a dev and a prod stage by default', () => {
    const { stacks } = stacksOf();
    expect(stacks.map((s) => s.stackName)).toEqual(['cupmark-dev-core', 'cupmark-prod-core']);
    expect(stacks.map((s) => s.cupmarkStage)).toEqual([...STAGES]);
  });

  it.each(STAGES)('selects only %s with -c stage=<name>', (stage) => {
    const { stacks } = stacksOf({ context: { stage } });
    expect(stacks.map((s) => s.stackName)).toEqual([`cupmark-${stage}-core`]);
  });

  it('rejects an unknown stage', () => {
    expect(() => testApp({ context: { stage: 'staging' } })).toThrow(/must be one of dev, prod/);
  });

  it('pins every stack to eu-central-1 and works without an account (offline synth)', () => {
    const { assembly, stacks } = stacksOf();
    for (const stack of stacks) {
      expect(stack.region).toBe(REGION);
      const artifact = assembly.getNestedAssembly(`assembly-${stack.cupmarkStage}`).getStackArtifact(stack.artifactId);
      expect(artifact.environment).toMatchObject({ region: REGION, account: 'unknown-account' });
    }
  });

  it('ignores CDK_DEFAULT_REGION and never moves out of eu-central-1', () => {
    const { stacks } = stacksOf({ env: { CDK_DEFAULT_REGION: 'us-east-1' } });
    expect(stacks.every((s) => s.region === REGION)).toBe(true);
  });

  it('takes the account from context, per stage, then from CDK_DEFAULT_ACCOUNT', () => {
    const fromContext = stacksOf({ context: { 'cupmark:prod:account': FAKE_ACCOUNT } });
    expect(fromContext.stacks.map((s) => s.account)).toEqual([expect.stringContaining('Token'), FAKE_ACCOUNT]);
    const fromEnv = stacksOf({ env: { CDK_DEFAULT_ACCOUNT: FAKE_ACCOUNT } });
    expect(fromEnv.stacks.map((s) => s.account)).toEqual([FAKE_ACCOUNT, FAKE_ACCOUNT]);
  });

  it('rejects an account id that is not 12 digits', () => {
    expect(() => testApp({ context: { 'cupmark:dev:account': '1234' } })).toThrow(/12 digits/);
  });

  it.each([
    ['without an account', {}],
    ['with an account', { env: { CDK_DEFAULT_ACCOUNT: FAKE_ACCOUNT } }],
  ])('passes every guard %s', (_label, options) => {
    const { app } = testApp(options);
    const violations = checkApp(app);
    expect(formatViolations(violations)).toBe('');
  });

  it('contains exactly the data, identity and API resources, and no CDK metadata resource', () => {
    for (const stack of stacksOf().stacks) {
      const template = Template.fromStack(stack).toJSON() as { Resources: Record<string, { Type: string }> };
      const counts: Record<string, number> = {};
      for (const r of Object.values(template.Resources)) counts[r.Type] = (counts[r.Type] ?? 0) + 1;
      expect(counts).toEqual({
        'AWS::DynamoDB::Table': 1,
        // photos, backups and the deletion log (ADR 0017).
        'AWS::S3::Bucket': 3,
        'AWS::S3::BucketPolicy': 3,
        'AWS::Cognito::UserPool': 1,
        'AWS::Cognito::UserPoolDomain': 1,
        'AWS::Cognito::UserPoolClient': 1,
        'AWS::ApiGatewayV2::Api': 1,
        'AWS::ApiGatewayV2::Stage': 1,
        'AWS::ApiGatewayV2::Authorizer': 1,
        'AWS::ApiGatewayV2::Integration': 2,
        'AWS::ApiGatewayV2::Route': API_ROUTES.length,
        // One invoke permission per route, scoped to that route's path.
        'AWS::Lambda::Permission': API_ROUTES.length,
        // api, health and the deploy-time apple-idp (ADR 0015).
        'AWS::Lambda::Function': 3,
        'AWS::IAM::Role': 3,
        'AWS::Logs::LogGroup': 3,
        'Custom::CupmarkAppleIdentityProvider': 1,
      });
      expect(Object.keys(template).sort()).toEqual(['Description', 'Outputs', 'Parameters', 'Resources', 'Rules']);
    }
  });

  it('uses the Cupmark bootstrap (qualifier cupmark), never the shared one', () => {
    const { assembly, stacks } = stacksOf();
    for (const stack of stacks) {
      Template.fromStack(stack).hasParameter('BootstrapVersion', { Default: '/cdk-bootstrap/cupmark/version' });
      const artifact = assembly.getNestedAssembly(`assembly-${stack.cupmarkStage}`).getStackArtifact(stack.artifactId);
      expect(artifact.assumeRoleArn).toContain(':role/cdk-cupmark-deploy-role-');
      expect(artifact.cloudFormationExecutionRoleArn).toContain(':role/cdk-cupmark-cfn-exec-role-');
      expect(artifact.stackTemplateAssetObjectUrl).toContain('s3://cdk-cupmark-assets-');
    }
  });

  it('tags every stack project=cupmark and turns on termination protection', () => {
    const { assembly, stacks } = stacksOf();
    for (const stack of stacks) {
      const artifact = assembly.getNestedAssembly(`assembly-${stack.cupmarkStage}`).getStackArtifact(stack.artifactId);
      expect(artifact.tags).toEqual({ project: 'cupmark', stage: stack.cupmarkStage });
      expect(artifact.terminationProtection).toBe(true);
    }
  });

  it('shares nothing between stages', () => {
    const [dev, prod] = stacksOf().stacks;
    if (dev === undefined || prod === undefined) throw new Error('stages missing');
    expect(JSON.stringify(Template.fromStack(dev).toJSON())).not.toContain('prod');
    expect(JSON.stringify(Template.fromStack(prod).toJSON())).not.toContain('cupmark-dev');
  });
});

describe('cdk.json', () => {
  const cdkJson = readCdkJson();

  it('runs the TypeScript entry point directly with Node', () => {
    expect(cdkJson.app).toBe('node bin/cupmark.ts');
  });

  it('disables context lookups, version reporting and CLI telemetry', () => {
    expect(cdkJson.lookups).toBe(false);
    expect(cdkJson.versionReporting).toBe(false);
    expect(cdkJson.context['cli-telemetry']).toBe(false);
  });

  it('turns template validation findings into synth errors', () => {
    expect(cdkJson.context['@aws-cdk/core:validateAgainstDefaultRules']).toBe(true);
  });

  it('has no cached lookup results (cdk.context.json)', () => {
    expect(existsSync(join(INFRA_DIR, 'cdk.context.json'))).toBe(false);
  });
});

describe('the guard lists', () => {
  it('never allow a type that is also denied', () => {
    for (const type of Object.keys(ALLOWED_RESOURCE_TYPES)) {
      const denied = DENIED_RESOURCE_TYPES.filter((d) => (d.match.endsWith('::') ? type.startsWith(d.match) : type === d.match));
      expect(denied, type).toEqual([]);
    }
  });
});

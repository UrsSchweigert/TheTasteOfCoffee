// CDK entry point (cdk.json "app"). Builds the dev and prod stages, synthesises
// them and exits 1 if any guard in src/guards.ts finds a violation. The templates
// are written to cdk.out before the check runs, so a failed synth must never be deployed.
import { buildApp } from '../src/app.ts';
import { checkApp, formatViolations } from '../src/guards.ts';

const { app } = buildApp();
const violations = checkApp(app);
if (violations.length > 0) {
  console.error(`Cupmark guards failed (${String(violations.length)}):\n${formatViolations(violations)}`);
  process.exit(1);
}

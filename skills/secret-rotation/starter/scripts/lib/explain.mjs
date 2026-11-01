import { isAuthError } from './safety.mjs';

// Turns the text of a failure into something a person can act on: what went wrong in a
// sentence and what to do about it. Cloud tools answer with JSON blobs that carry
// subscription ids and correlation ids, none of which help, so they are cut out. An
// error the tool wrote itself is already plain and is kept.
const RESOURCE_PATH = /\/subscriptions\/[0-9a-f-]{8,}(?:\/[^\s"',)}\]]*)?/gi;

const clean = (text) =>
  text
    .replace(RESOURCE_PATH, '<azure resource>')
    .replace(/\s*Please list deployment operations for details\.?/gi, '')
    .replace(/\s*Please see https?:\/\/\S+ for usage details\.?/gi, '')
    .replace(/\s*Correlation ID:?\s*[0-9a-f-]+\.?/gi, '')
    .replace(/^ERROR:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

const shorten = (text, max = 240) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function armMessages(text) {
  const start = text.indexOf('{');
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(text.slice(start));
    const error = parsed.error ?? parsed;
    const details = (error.details ?? []).map((detail) => detail.message).filter(Boolean);
    return details.length ? details : [error.message].filter(Boolean);
  } catch {
    return [];
  }
}

const CHECK = 'Run npm run secrets:check to see where things stand.';

const RULES = [
  {
    test: /Changing property '([^']+)' is not allowed/,
    explain: (match) => ({
      what: `Azure does not allow changing "${match[1]}" on something that already exists.`,
      fix: 'That setting is fixed when the resource is created. Change the value another way, or delete the resource and create it again.',
    }),
  },
  {
    test: /OperationPreempted|preempted by a more recent operation/i,
    explain: () => ({
      what: 'Another operation on the same resource interrupted this one.',
      fix: "Something else changed it at the same moment (in this setup the app's idle stop can). Hold it on, or wait a minute, and run this again.",
    }),
  },
  {
    test: /VM is no longer running/,
    explain: () => ({
      what: 'The VM stopped while it was being changed.',
      fix: "Something turned it off (in this setup the app's idle stop does). Run this again, the runner is held on while it works.",
    }),
  },
  {
    test: /holds neither the old nor the new token/,
    explain: () => ({
      what: 'The VM does not have the token the deploy file says it has.',
      fix: 'The deploy file and the VM have drifted apart. Find out which token the VM really accepts, put that one in the deploy file, and run this again.',
    }),
  },
  {
    test: /AuthorizationFailed|does not have authorization/i,
    explain: () => ({
      what: 'Your Azure account is not allowed to do this.',
      fix: 'Check you are on the right subscription (az account show) and have the Contributor role on the resource group.',
    }),
  },
  {
    test: (text) => isAuthError(text),
    explain: (_match, text) => ({
      what: 'Your login is missing or has expired.',
      fix: /gh auth|github/i.test(text)
        ? 'Run gh auth login, then run this again.'
        : 'Run az login, then run this again.',
    }),
  },
  {
    test: /ResourceGroupNotFound|ResourceNotFound|ParentResourceNotFound|could not be found/i,
    explain: () => ({
      what: 'Azure cannot find a resource it was told to use.',
      fix: 'Check the names in scripts/secrets.config.mjs and that you are on the right subscription.',
    }),
  },
  {
    test: /AllocationFailed|SkuNotAvailable|QuotaExceeded|OverconstrainedAllocationRequest/,
    explain: () => ({
      what: 'Azure has no capacity or quota available for this right now.',
      fix: 'Try again later, or choose another size or region.',
    }),
  },
  {
    test: /VMAgent|agent is not ready/i,
    explain: () => ({
      what: 'The VM is not ready to take commands yet.',
      fix: 'Wait a minute and run it again. A VM that was just started needs time before its agent answers.',
    }),
  },
  {
    test: /EAI_AGAIN|ENOTFOUND|ECONN|ETIMEDOUT|getaddrinfo|timed out/i,
    explain: () => ({
      what: 'Could not reach the service.',
      fix: 'Check your internet connection and run it again.',
    }),
  },
  {
    test: /Resource not accessible|HTTP 40[34]/,
    explain: () => ({
      what: 'GitHub refused the request.',
      fix: 'You need admin access to the repository. Run gh auth refresh -s repo and try again.',
    }),
  },
];

export function explainFailure(text) {
  const raw = String(text ?? '');
  for (const rule of RULES) {
    const match = typeof rule.test === 'function' ? rule.test(raw) && [] : rule.test.exec(raw);
    if (match) return rule.explain(match, raw);
  }
  const messages = armMessages(raw);
  const what = shorten(
    clean(messages[0] ?? (raw.includes('{') ? raw.slice(0, raw.indexOf('{')) : raw)),
  );
  const fix = /not healthy|health/i.test(raw)
    ? 'Read the app logs, and run npm run secrets -- --rollback if the app is down.'
    : CHECK;
  return { what: what || 'Something went wrong, and no details were given.', fix };
}

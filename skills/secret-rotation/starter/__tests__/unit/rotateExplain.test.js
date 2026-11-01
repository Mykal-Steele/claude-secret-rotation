import { explainFailure } from '../../scripts/lib/explain.mjs';

const arm = (code, message, details = []) =>
  `ERROR: ${JSON.stringify({
    status: 'Failed',
    error: {
      code: 'DeploymentFailed',
      target:
        '/subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/my-rg/providers/Microsoft.Resources/deployments/app',
      message:
        'At least one resource deployment operation failed. Please list deployment operations for details. Correlation ID: abcd1234-0000-1111-2222-333344445555',
      details: [{ code, target: 'osProfile.customData', message }, ...details],
    },
  })}`;

describe('explainFailure', () => {
  test('explains a property Azure will not change, from the real failure text', () => {
    const result = explainFailure(
      arm('PropertyChangeNotAllowed', "Changing property 'osProfile.customData' is not allowed."),
    );
    expect(result.what).toMatch(/osProfile\.customData/);
    expect(result.what).toMatch(/does not allow/i);
    expect(result.fix).toMatch(/created/i);
  });

  test('never shows raw JSON, subscription ids, resource paths or correlation ids', () => {
    for (const text of [
      arm('PropertyChangeNotAllowed', "Changing property 'osProfile.customData' is not allowed."),
      arm('SomethingNew', 'The thing broke in a way nobody listed.'),
    ]) {
      const { what, fix } = explainFailure(text);
      for (const shown of [what, fix]) {
        expect(shown).not.toMatch(/[{}]/);
        expect(shown).not.toMatch(/00000000-1111/);
        expect(shown).not.toMatch(/\/subscriptions\//);
        expect(shown).not.toMatch(/Correlation ID/i);
      }
    }
  });

  test('uses the inner message of an Azure error it has no rule for', () => {
    const result = explainFailure(arm('SomethingNew', 'The thing broke in a way nobody listed.'));
    expect(result.what).toBe('The thing broke in a way nobody listed.');
    expect(result.fix).toMatch(/secrets:check/);
  });

  test('explains a missing permission', () => {
    const result = explainFailure(
      'ERROR: (AuthorizationFailed) The client does not have authorization to perform action X over scope Y',
    );
    expect(result.what).toMatch(/not allowed/i);
    expect(result.fix).toMatch(/subscription/i);
    expect(result.fix).toMatch(/Contributor|role/i);
  });

  test('points an expired login at the login command', () => {
    expect(explainFailure("ERROR: Please run 'az login' to setup account.").fix).toMatch(
      /az login/,
    );
    expect(explainFailure('AADSTS70043: The refresh token has expired').fix).toMatch(/az login/);
    expect(explainFailure('To get started with GitHub CLI, please run: gh auth login').fix).toMatch(
      /gh auth login/,
    );
  });

  test('explains a resource that cannot be found', () => {
    const result = explainFailure(
      'ERROR: (ResourceGroupNotFound) Resource group my-rg could not be found.',
    );
    expect(result.what).toMatch(/cannot find|could not be found|not find/i);
    expect(result.fix).toMatch(/secrets\.config\.mjs/);
  });

  test('explains missing capacity', () => {
    for (const text of [
      'AllocationFailed: out of capacity',
      'SkuNotAvailable: size not offered',
      'QuotaExceeded: cores',
    ]) {
      expect(explainFailure(text).what).toMatch(/capacity|quota|available/i);
    }
  });

  test('explains network trouble', () => {
    for (const text of [
      'getaddrinfo EAI_AGAIN login.microsoftonline.com',
      'connect ECONNREFUSED 1.2.3.4:443',
      'request timed out',
    ]) {
      const result = explainFailure(text);
      expect(result.what).toMatch(/reach/i);
      expect(result.fix).toMatch(/internet|connection/i);
    }
  });

  test('explains a VM agent that is not ready', () => {
    const result = explainFailure('VMAgentStatusCommunicationError: the VM agent is not ready');
    expect(result.what).toMatch(/VM/);
    expect(result.fix).toMatch(/wait|again/i);
  });

  test('explains a GitHub permission problem', () => {
    const result = explainFailure('HTTP 403: Resource not accessible by personal access token');
    expect(result.what).toMatch(/GitHub/);
    expect(result.fix).toMatch(/admin|gh auth refresh/);
  });

  test('keeps a plain message the tool wrote itself and adds a next step', () => {
    const text = 'The app was not healthy 240 seconds after the change. Last answer: 502.';
    const result = explainFailure(text);
    expect(result.what).toBe(text);
    expect(result.fix).toMatch(/logs|secrets:check/);
  });

  test('shortens very long text and strips resource paths from it', () => {
    const long = `${'x'.repeat(400)} /subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/my-rg/providers/Microsoft.Compute/virtualMachines/vm`;
    const { what } = explainFailure(long);
    expect(what.length).toBeLessThanOrEqual(240);
    expect(what).not.toMatch(/\/subscriptions\//);
  });

  test('always returns something to read, even for empty text', () => {
    const result = explainFailure('');
    expect(result.what.length).toBeGreaterThan(0);
    expect(result.fix.length).toBeGreaterThan(0);
  });

  test('explains a VM that does not hold the token the deploy file says it holds', () => {
    const result = explainFailure(
      'The change on the VM did not finish: Enable succeeded:\n[stdout]\nthe proxy config holds neither the old nor the new token\n[stderr]',
    );
    expect(result.what).toMatch(/does not have the token/i);
    expect(result.fix).toMatch(/deploy file|drift|which token/i);
  });

  test('explains an operation that another operation on the same resource cut off', () => {
    const result = explainFailure(
      '(OperationPreempted) Operation execution has been preempted by a more recent operation.',
    );
    expect(result.what).toMatch(/interrupted|cut off/i);
    expect(result.fix).toMatch(/hold|again/i);
  });
});

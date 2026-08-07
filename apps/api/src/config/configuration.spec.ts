import configuration, { validateEnv } from './configuration';

describe('Level 2 configuration safety', () => {
  const names = [
    'WEBULL_L2_ENABLED',
    'WEBULL_L2_CAPABILITY_PROVEN',
    'WEBULL_L2_APP_KEY',
    'WEBULL_L2_APP_SECRET',
    'WEBULL_L2_MAX_DEPTH',
    'REDIS_URL',
  ] as const;
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  afterEach(() => {
    for (const name of names) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('defaults Level 2 to disabled and entitlement-unproven', () => {
    for (const name of names) delete process.env[name];
    expect(configuration().webull).toMatchObject({
      l2Enabled: false,
      l2CapabilityProven: false,
      l2MaxDepth: 50,
    });
  });

  it.each([
    ['WEBULL_L2_CAPABILITY_PROVEN', 'false'],
    ['WEBULL_L2_APP_KEY', ''],
    ['WEBULL_L2_APP_SECRET', ''],
    ['REDIS_URL', ''],
    ['WEBULL_L2_MAX_DEPTH', '51'],
  ] as const)('rejects enabled L2 when %s is unsafe', (name, value) => {
    Object.assign(process.env, {
      WEBULL_L2_ENABLED: 'true',
      WEBULL_L2_CAPABILITY_PROVEN: 'true',
      WEBULL_L2_APP_KEY: 'key',
      WEBULL_L2_APP_SECRET: 'secret',
      WEBULL_L2_MAX_DEPTH: '50',
      REDIS_URL: 'redis://127.0.0.1:6379',
      [name]: value,
    });
    expect(() => validateEnv({})).toThrow(/WEBULL_L2|REDIS_URL/);
  });

  it('accepts explicit proven configuration without contacting dependencies', () => {
    Object.assign(process.env, {
      WEBULL_L2_ENABLED: 'true',
      WEBULL_L2_CAPABILITY_PROVEN: 'true',
      WEBULL_L2_APP_KEY: 'key',
      WEBULL_L2_APP_SECRET: 'secret',
      WEBULL_L2_MAX_DEPTH: '25',
      REDIS_URL: 'redis://127.0.0.1:6379',
    });
    expect(validateEnv({ marker: true })).toEqual({ marker: true });
  });
});

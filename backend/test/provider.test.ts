import { describe, it, expect } from 'vitest';
import { SandboxProvider } from '../src/providers/sandbox.js';
import { MoyasarProvider } from '../src/providers/moyasar.js';
import { TapProvider } from '../src/providers/tap.stub.js';

describe('providers — stubs refuse without secrets', () => {
  it('Moyasar throws without a secret key', () => {
    expect(() => new MoyasarProvider('', '')).toThrow(/MOYASAR_SECRET_KEY/);
  });
  it('Tap throws without a secret key', () => {
    expect(() => new TapProvider('', '')).toThrow(/TAP_SECRET_KEY/);
  });
  it('Moyasar rejects split-payment (no native marketplace)', async () => {
    const m = new MoyasarProvider('sk_test_x', 'wh_x');
    await expect(m.createSplitPayment({
      amountHalalahs: 100n, currency: 'SAR', orderRef: 'x', destinations: [],
    })).rejects.toThrow(/marketplace/);
  });
});

describe('providers — sandbox split payment', () => {
  it('accepts a valid split (destinations sum ≤ total)', async () => {
    const p = new SandboxProvider();
    const r = await p.createSplitPayment({
      amountHalalahs: 100_000n, currency: 'SAR', orderRef: 'ord-1',
      destinations: [
        { beneficiaryId: 'ben_a', amountHalalahs: 70_000n },
        { beneficiaryId: 'ben_b', amountHalalahs: 30_000n },
      ],
    });
    expect(r.providerPaymentId).toMatch(/^sb_split_/);
    expect(r.status).toBe('initiated');
  });

  it('rejects a split where destinations exceed the total', async () => {
    const p = new SandboxProvider();
    await expect(p.createSplitPayment({
      amountHalalahs: 100n, currency: 'SAR', orderRef: 'ord-2',
      destinations: [{ beneficiaryId: 'ben_a', amountHalalahs: 200n }],
    })).rejects.toThrow(/exceed/);
  });
});

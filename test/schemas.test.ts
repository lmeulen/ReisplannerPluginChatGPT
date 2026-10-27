import { describe, expect, it } from 'vitest';
import { planInputSchema, departuresInputSchema, disruptionsInputSchema } from '../src/schemas';

describe('public input contracts', () => {
  it('accepts explicit offsets and defaults an omitted time to server now', () => {
    expect(planInputSchema.parse({ from: 'Gouda', to: 'Leiden' })).toMatchObject({ searchForArrival: false, accessible: false, language: 'nl' });
    expect(planInputSchema.safeParse({ from: 'Gouda', to: 'Leiden', dateTime: '2026-10-26T09:00:00+01:00' }).success).toBe(true);
    expect(planInputSchema.safeParse({ from: 'Gouda', to: 'Leiden', dateTime: '2026-10-26T09:00:00' }).success).toBe(false);
  });
  it('requires an explicit arrival deadline', () => {
    expect(planInputSchema.safeParse({ from: 'Gouda', to: 'Leiden', searchForArrival: true }).success).toBe(false);
  });
  it('rejects absent endpoints, unknown parameters and oversized departure boards', () => {
    expect(planInputSchema.safeParse({ to: 'Leiden' }).success).toBe(false);
    expect(planInputSchema.safeParse({ from: 'Gouda', to: 'Leiden', apiKey: 'secret' }).success).toBe(false);
    expect(departuresInputSchema.parse({ station: 'Gouda' }).limit).toBe(10);
    expect(departuresInputSchema.safeParse({ station: 'Gouda', limit: 21 }).success).toBe(false);
  });
  it('keeps future disruptions by default', () => {
    expect(disruptionsInputSchema.parse({})).toEqual({ language: 'nl' });
  });
});

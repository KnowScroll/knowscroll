import { describe, expect, it } from 'vitest';
import { CAST_MAX, CAST_MIN, DEFAULT_CAST, castProblem, nameOf } from './cast.js';

describe('the cast of a room', () => {
  it('starts every room with a named Explainer and a named Skeptic', () => {
    expect(DEFAULT_CAST.map((member) => member.inhabitant)).toEqual(['explainer', 'skeptic']);
    expect(castProblem(DEFAULT_CAST)).toBeUndefined();
    expect(DEFAULT_CAST.length).toBeGreaterThanOrEqual(CAST_MIN);
    expect(DEFAULT_CAST.length).toBeLessThanOrEqual(CAST_MAX);
  });

  it('refuses a cast without both required roles, with a repeated role or name, or with a bad name', () => {
    const [explainer, skeptic] = DEFAULT_CAST as [(typeof DEFAULT_CAST)[0], (typeof DEFAULT_CAST)[1]];
    expect(castProblem([explainer])).toBe('too_small');
    expect(castProblem([explainer, skeptic, explainer, skeptic, explainer])).toBe('too_large');
    expect(castProblem([explainer, explainer])).toBe('repeated_role');
    expect(castProblem([explainer, { inhabitant: 'skeptic', name: 'nova' }])).toBe('repeated_name');
    expect(castProblem([explainer, { ...skeptic, name: '  ' }])).toBe('bad_name');
    expect(castProblem([explainer, { ...skeptic, name: 'x'.repeat(25) }])).toBe('bad_name');
  });

  it('names a resident by its place in the cast', () => {
    expect(nameOf(DEFAULT_CAST, 'skeptic')).toBe('Halley');
    expect(nameOf([], 'skeptic')).toBe('skeptic');
  });
});

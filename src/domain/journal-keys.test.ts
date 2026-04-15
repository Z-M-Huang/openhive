import { describe, it, expect } from 'vitest';
import {
  learningJournalKey,
  reflectionJournalKey,
  isLearningJournalKey,
  isReflectionJournalKey,
} from './journal-keys.js';

describe('journal-keys (AC-37)', () => {
  describe('learningJournalKey', () => {
    it('produces learning:{team}:{subagent}:journal', () => {
      expect(learningJournalKey('ops', 'planner')).toBe('learning:ops:planner:journal');
      expect(learningJournalKey('team-alpha', 'coder')).toBe('learning:team-alpha:coder:journal');
    });

    it('keeps learning and reflection keys distinct', () => {
      expect(learningJournalKey('ops', 'planner')).not.toBe(reflectionJournalKey('ops', 'planner'));
    });

    it('throws for invalid team or subagent segments', () => {
      expect(() => learningJournalKey('', 'planner')).toThrow(/team/);
      expect(() => learningJournalKey('ops', '')).toThrow(/subagent/);
      expect(() => learningJournalKey('ops:colon', 'planner')).toThrow(/team/);
      expect(() => learningJournalKey('ops', 'planner:colon')).toThrow(/subagent/);
      expect(() => learningJournalKey('ops', 'plan space')).toThrow(/subagent/);
    });
  });

  describe('reflectionJournalKey', () => {
    it('produces reflection:{team}:{subagent}:journal', () => {
      expect(reflectionJournalKey('ops', 'planner')).toBe('reflection:ops:planner:journal');
      expect(reflectionJournalKey('data', 'scorer')).toBe('reflection:data:scorer:journal');
    });

    it('throws for invalid segments', () => {
      expect(() => reflectionJournalKey('', 'planner')).toThrow(/team/);
      expect(() => reflectionJournalKey('ops', '')).toThrow(/subagent/);
    });
  });

  describe('isLearningJournalKey / isReflectionJournalKey', () => {
    it('recognizes well-formed learning keys', () => {
      expect(isLearningJournalKey('learning:ops:planner:journal')).toBe(true);
      expect(isLearningJournalKey('reflection:ops:planner:journal')).toBe(false);
    });

    it('recognizes well-formed reflection keys', () => {
      expect(isReflectionJournalKey('reflection:ops:planner:journal')).toBe(true);
      expect(isReflectionJournalKey('learning:ops:planner:journal')).toBe(false);
    });

    it('rejects malformed keys', () => {
      expect(isLearningJournalKey('learning:ops:journal')).toBe(false);
      expect(isLearningJournalKey('lesson:ops:planner:journal')).toBe(false);
      expect(isReflectionJournalKey('reflection:ops:planner:notes')).toBe(false);
    });

    it('round-trips with the constructor functions', () => {
      expect(isLearningJournalKey(learningJournalKey('ops', 'planner'))).toBe(true);
      expect(isReflectionJournalKey(reflectionJournalKey('ops', 'planner'))).toBe(true);
    });
  });
});

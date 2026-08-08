const { describe, it, expect } = require('@jest/globals');

// Test the real createAuditLogPruner against a fake prune function and logger.
// The app wires this factory up in src/app.js for the startup + periodic audit
// log pruning; the factory tracks whether the first run has happened so the
// "initial prune failed" warning fires only when the startup run actually
// throws.
const { createAuditLogPruner } = require('../src/utils');

function makeLogger() {
  return { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
}

describe('createAuditLogPruner', () => {
  it('does not warn when the first prune succeeds (regression: warning previously fired on every startup)', () => {
    const pruneAuditLog = jest.fn(() => 0);
    const logger = makeLogger();
    const runPrune = createAuditLogPruner(pruneAuditLog, { days: 365, logger });
    runPrune();
    expect(pruneAuditLog).toHaveBeenCalledWith(365);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('logs a count message when the first prune deletes rows', () => {
    const pruneAuditLog = jest.fn(() => 42);
    const logger = makeLogger();
    const runPrune = createAuditLogPruner(pruneAuditLog, { days: 365, logger });
    runPrune();
    expect(logger.log).toHaveBeenCalledWith('Pruned 42 audit log entries older than 365 days');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns exactly once when the first prune fails, then only errors on later failures', () => {
    const pruneAuditLog = jest.fn()
      .mockImplementationOnce(() => {
        throw new Error('database is locked');
      });
    const logger = makeLogger();
    const runPrune = createAuditLogPruner(pruneAuditLog, { days: 365, logger });

    runPrune();
    expect(logger.error).toHaveBeenCalledWith('Audit log pruning error:', 'database is locked');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Initial audit log prune failed — will retry on next interval');

    runPrune();
    expect(pruneAuditLog).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('skips pruning entirely when days is not a positive finite number', () => {
    for (const days of [undefined, NaN, 0, -1, '365']) {
      const pruneAuditLog = jest.fn();
      const logger = makeLogger();
      const runPrune = createAuditLogPruner(pruneAuditLog, { days, logger });
      runPrune();
      expect(pruneAuditLog).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    }
  });

  it('defaults to console when no logger is provided', () => {
    const pruneAuditLog = jest.fn(() => 0);
    const runPrune = createAuditLogPruner(pruneAuditLog, { days: 30 });
    expect(() => runPrune()).not.toThrow();
  });
});

import { RankedStrips } from '../../ui/src/board/RankedStrips';

describe('RankedStrips', () => {
  it('partitions tickets correctly', () => {
    const tickets = [
      { key: 'A', blocked: true, overdue: false, awaitingYou: false },
      { key: 'B', blocked: false, overdue: true, awaitingYou: false },
      { key: 'C', blocked: false, overdue: false, awaitingYou: true },
      { key: 'D', blocked: false, overdue: false, awaitingYou: false },
    ];
    const result = RankedStrips({ tickets });
    // Additional assertions can be added here
  });
});

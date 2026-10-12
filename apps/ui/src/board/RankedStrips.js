import React from 'react';

function TicketCard({ key, summary }) {
  return <div className="ticket-card">{key}: {summary}</div>;
}

export function RankedStrips({ tickets }) {
  const blocked = tickets.filter(t => t.blocked);
  const overdue = tickets.filter(t => t.overdue);
  const awaitingYou = tickets.filter(t => t.awaitingYou);
  return (
    <div className="board-strips">
      <div className="strip blocked">
        <h2>Blocked</h2>
        {blocked.map(TicketCard)}
      </div>
      <div className="strip overdue">
        <h2>Overdue</h2>
        {overdue.map(TicketCard)}
      </div>
      <div className="strip awaiting-you">
        <h2>Awaiting You</h2>
        {awaitingYou.map(TicketCard)}
      </div>
    </div>
  );
}

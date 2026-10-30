export default function IncomingCall({ from, onAnswer, onDecline }: { from: string; onAnswer: () => void; onDecline: () => void }) {
  return (
    <div className="overlay">
      <div className="card">
        <h2>Incoming call</h2>
        <p style={{ fontSize: 22 }}>+{from.replace(/^\+/, '')}</p>
        <div className="row">
          <button className="danger" onClick={onDecline}>Decline</button>
          <button onClick={onAnswer}>Answer</button>
        </div>
      </div>
    </div>
  );
}

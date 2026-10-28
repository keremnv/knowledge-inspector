import "./ProblemNotice.css";

/**
 * A local interruption, using the same ruled surface as the reader.
 *
 * Message only, deliberately: recovery happens outside the page — reopen the
 * world and use the new inspector link — so a retry button would promise what
 * this page cannot do. A refresh re-runs the load for the transient cases.
 */
export function ProblemNotice({ message, title = "Unable to load data" }: {
  message: string;
  title?: string;
}) {
  const separator = message.indexOf("\n");
  const heading = separator < 0 ? title : message.slice(0, separator);
  const detail = separator < 0 ? message : message.slice(separator + 1);
  const command = "author open <world-name>";
  const parts = detail.split(command);
  return (
    <div className="problem-notice" role="alert">
      <strong className="problem-notice__title">{heading}</strong>
      <p>{parts.map((part, index) => <span key={index}>{index > 0 ? <code>{command}</code> : null}{part}</span>)}</p>
    </div>
  );
}

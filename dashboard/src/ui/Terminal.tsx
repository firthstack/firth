import React from 'react'

export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="firth-panel">
      <div className="firth-panel__title">{title}</div>
      <div className="firth-panel__body">{children}</div>
    </section>
  )
}

export function Row({ children }: { children: React.ReactNode }) {
  return <div className="firth-row">{children}</div>
}

export function TButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className, ...rest } = props
  return <button {...rest} className={`firth-btn${className ? ` ${className}` : ''}`} />
}

export function TInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props
  return <input {...rest} className={`firth-input${className ? ` ${className}` : ''}`} />
}

// CliHint — a copyable `$ <command>` line with an optional trailing comment.
// Used to show the firth CLI equivalent of an on-screen action.
export function CliHint({ command, note }: { command: string; note?: string }) {
  return (
    <div className="firth-clihint">
      <span className="firth-dim firth-clihint__prompt">$</span>
      <code className="firth-clihint__cmd">{command}</code>
      {note && <span className="firth-dim firth-clihint__note">{note}</span>}
      <button
        type="button"
        className="firth-btn firth-clihint__copy"
        title={command}
        aria-label="copy command"
        onClick={() => navigator.clipboard?.writeText(command)}
      >
        [copy]
      </button>
    </div>
  )
}

export function Confirm({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="firth-confirm" role="alertdialog" aria-label="confirm">
      <p className="firth-error">{message}</p>
      <Row>
        <TButton className="firth-btn--danger" onClick={onConfirm}>[confirm]</TButton>
        <TButton onClick={onCancel}>[cancel]</TButton>
      </Row>
    </div>
  )
}

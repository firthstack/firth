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

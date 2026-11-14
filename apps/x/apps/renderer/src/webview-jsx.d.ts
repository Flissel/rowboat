import 'react'

// <webview> ist ein Electron-Element, kein React-Standard: nur die Attribute, die die Oberfläche setzen darf.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: {
        ref?: React.Ref<HTMLElement>
        src?: string
        partition?: string
        style?: React.CSSProperties
      }
    }
  }
}

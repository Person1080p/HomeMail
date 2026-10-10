// Minimal declarations for the parts of xmpp.js (@xmpp/component) HomeMail uses.
declare module '@xmpp/component' {
  export interface XmlElement {
    name: string;
    attrs: Record<string, string | undefined>;
    children: (XmlElement | string)[];
    is(name: string, xmlns?: string): boolean;
    getChild(name: string, xmlns?: string): XmlElement | undefined;
    getChildText(name: string, xmlns?: string): string | null;
    getChildElements(): XmlElement[];
    append(el: XmlElement | XmlElement[]): XmlElement;
    toString(): string;
  }
  export interface IqContext {
    stanza: XmlElement;
    element: XmlElement;
    from: { toString(): string };
    to: { toString(): string; local?: string };
  }
  type IqHandler = (ctx: IqContext) => XmlElement | boolean | Promise<XmlElement | boolean>;
  export interface Component {
    on(event: 'stanza', fn: (stanza: XmlElement) => void): void;
    on(event: 'online', fn: (address: unknown) => void): void;
    on(event: 'offline' | 'disconnect', fn: () => void): void;
    on(event: 'error', fn: (err: Error) => void): void;
    on(event: 'status', fn: (status: string) => void): void;
    start(): Promise<unknown>;
    stop(): Promise<void>;
    send(...stanzas: XmlElement[]): Promise<void>;
    status: string;
    iqCallee: { get(ns: string, name: string, handler: IqHandler): void; set(ns: string, name: string, handler: IqHandler): void };
  }
  export function component(options: { service: string; domain: string; password: string }): Component;
  export function xml(name: string, attrs?: Record<string, string | undefined> | null, ...children: (XmlElement | string)[]): XmlElement;
}

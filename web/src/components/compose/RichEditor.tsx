import { forwardRef, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { Highlight } from '@tiptap/extension-highlight';
import { TextAlign } from '@tiptap/extension-text-align';
import { Subscript } from '@tiptap/extension-subscript';
import { Superscript } from '@tiptap/extension-superscript';
import { Image } from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Icon } from '../Icon';
import { Menu } from '../ui';

export const DEFAULT_FONT = 'Arial, Helvetica, sans-serif';
export const DEFAULT_SIZE = '11pt';

const FONTS: [string, string][] = [
  ['Arial', 'Arial, Helvetica, sans-serif'],
  ['Calibri', 'Calibri, Carlito, sans-serif'],
  ['Georgia', 'Georgia, serif'],
  ['Times New Roman', '"Times New Roman", Times, serif'],
  ['Verdana', 'Verdana, Geneva, sans-serif'],
  ['Tahoma', 'Tahoma, Geneva, sans-serif'],
  ['Trebuchet MS', '"Trebuchet MS", sans-serif'],
  ['Courier New', '"Courier New", Courier, monospace'],
  ['Comic Sans MS', '"Comic Sans MS", "Comic Sans", cursive'],
];
const SIZES = ['8', '9', '10', '11', '12', '14', '16', '18', '20', '24', '28', '36', '48', '72'];
const TEXT_COLORS = ['#000000', '#444444', '#888888', '#c00000', '#e36c09', '#b8860b', '#00a050', '#0070c0', '#002060', '#7030a0', '#ff0000', '#ffc000', '#92d050', '#00b0f0', '#ff66cc', '#ffffff'];
const HIGHLIGHTS = ['#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#ffc000', '#ff9999', '#c0c0c0', '#99ccff'];

export interface RichEditorHandle {
  getHTML(): string;
  getText(): string;
  setHTML(html: string): void;
  focus(): void;
}

const readAsDataUrl = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

function insertImages(editor: Editor, files: File[]) {
  for (const f of files) readAsDataUrl(f).then((src) => editor.chain().focus().setImage({ src, alt: f.name }).run());
}

function Btn({ editor, title, active, disabled, onClick, children }: { editor: Editor; title: string; active?: boolean; disabled?: boolean; onClick: (e: Editor) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={active ? 'active' : ''}
      disabled={disabled}
      // Keep the editor's selection when clicking toolbar buttons.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onClick(editor)}
    >
      {children}
    </button>
  );
}

function Swatches({ colors, onPick, onClear, clearLabel, custom }: { colors: string[]; onPick: (c: string) => void; onClear: () => void; clearLabel: string; custom?: boolean }) {
  return (
    <div className="swatches">
      <div className="swatch-grid">
        {colors.map((c) => (
          <button key={c} type="button" className="swatch" style={{ background: c }} title={c} aria-label={c} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(c)} />
        ))}
      </div>
      <button type="button" className="link-btn small" onMouseDown={(e) => e.preventDefault()} onClick={onClear}>
        {clearLabel}
      </button>
      {custom && (
        <label className="inline small">
          Custom <input type="color" onChange={(e) => onPick(e.target.value)} />
        </label>
      )}
    </div>
  );
}

function Toolbar({ editor, onAttach }: { editor: Editor; onAttach?: () => void }) {
  const imageInput = useRef<HTMLInputElement>(null);
  const attrs = editor.getAttributes('textStyle');
  const font = FONTS.find(([, v]) => v === attrs.fontFamily)?.[1] ?? '';
  const size = typeof attrs.fontSize === 'string' ? attrs.fontSize.replace(/pt$/, '') : '';
  const block = editor.isActive('heading', { level: 1 })
    ? 'h1'
    : editor.isActive('heading', { level: 2 })
      ? 'h2'
      : editor.isActive('heading', { level: 3 })
        ? 'h3'
        : editor.isActive('codeBlock')
          ? 'code'
          : 'p';
  const inTable = editor.isActive('table');
  const inList = editor.isActive('bulletList') || editor.isActive('orderedList');
  const chain = () => editor.chain().focus();

  const setBlock = (v: string) => {
    if (v === 'p') chain().setParagraph().run();
    else if (v === 'code') chain().toggleCodeBlock().run();
    else chain().toggleHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 }).run();
  };

  const editLink = () => {
    const current = editor.getAttributes('link').href as string | undefined;
    const url = prompt('Link address (leave empty to remove the link):', current ?? 'https://');
    if (url === null) return;
    if (!url.trim()) chain().extendMarkRange('link').unsetLink().run();
    else if (/^(https?:|mailto:|tel:)/i.test(url.trim())) chain().extendMarkRange('link').setLink({ href: url.trim() }).run();
    else chain().extendMarkRange('link').setLink({ href: `https://${url.trim()}` }).run();
  };

  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
      <div className="tb-group">
        <Btn editor={editor} title="Undo (Ctrl+Z)" disabled={!editor.can().undo()} onClick={() => chain().undo().run()}>
          <Icon name="undo" size={15} />
        </Btn>
        <Btn editor={editor} title="Redo (Ctrl+Y)" disabled={!editor.can().redo()} onClick={() => chain().redo().run()}>
          <Icon name="redo" size={15} />
        </Btn>
      </div>
      <div className="tb-group">
        <select
          className="tb-select tb-font"
          value={font}
          title="Font"
          aria-label="Font"
          onChange={(e) => (e.target.value ? chain().setFontFamily(e.target.value).run() : chain().unsetFontFamily().run())}
        >
          <option value="">Default font</option>
          {FONTS.map(([name, value]) => (
            <option key={name} value={value} style={{ fontFamily: value }}>
              {name}
            </option>
          ))}
        </select>
        <select
          className="tb-select tb-size"
          value={size}
          title="Font size"
          aria-label="Font size"
          onChange={(e) => (e.target.value ? chain().setFontSize(`${e.target.value}pt`).run() : chain().unsetFontSize().run())}
        >
          <option value="">Size</option>
          {SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select className="tb-select" value={block} title="Paragraph style" aria-label="Paragraph style" onChange={(e) => setBlock(e.target.value)}>
          <option value="p">Normal</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
          <option value="code">Code</option>
        </select>
      </div>
      <div className="tb-group">
        <Btn editor={editor} title="Bold (Ctrl+B)" active={editor.isActive('bold')} onClick={() => chain().toggleBold().run()}>
          <b>B</b>
        </Btn>
        <Btn editor={editor} title="Italic (Ctrl+I)" active={editor.isActive('italic')} onClick={() => chain().toggleItalic().run()}>
          <i>I</i>
        </Btn>
        <Btn editor={editor} title="Underline (Ctrl+U)" active={editor.isActive('underline')} onClick={() => chain().toggleUnderline().run()}>
          <u>U</u>
        </Btn>
        <Btn editor={editor} title="Strikethrough" active={editor.isActive('strike')} onClick={() => chain().toggleStrike().run()}>
          <s>S</s>
        </Btn>
        <Btn editor={editor} title="Subscript" active={editor.isActive('subscript')} onClick={() => chain().toggleSubscript().run()}>
          X<sub>2</sub>
        </Btn>
        <Btn editor={editor} title="Superscript" active={editor.isActive('superscript')} onClick={() => chain().toggleSuperscript().run()}>
          X<sup>2</sup>
        </Btn>
        <Menu
          trigger={(open) => (
            <button type="button" title="Font colour" aria-label="Font colour" onMouseDown={(e) => e.preventDefault()} onClick={open} className="color-btn">
              <span className="color-a">A</span>
              <span className="color-bar" style={{ background: (attrs.color as string) || 'currentColor' }} />
            </button>
          )}
        >
          {(close) => (
            <Swatches
              colors={TEXT_COLORS}
              custom
              clearLabel="Automatic"
              onPick={(c) => (chain().setColor(c).run(), close())}
              onClear={() => (chain().unsetColor().run(), close())}
            />
          )}
        </Menu>
        <Menu
          trigger={(open) => (
            <button type="button" title="Highlight" aria-label="Highlight" onMouseDown={(e) => e.preventDefault()} onClick={open} className={editor.isActive('highlight') ? 'active' : ''}>
              <Icon name="highlighter" size={15} />
            </button>
          )}
        >
          {(close) => (
            <Swatches
              colors={HIGHLIGHTS}
              clearLabel="No highlight"
              onPick={(c) => (chain().setHighlight({ color: c }).run(), close())}
              onClear={() => (chain().unsetHighlight().run(), close())}
            />
          )}
        </Menu>
        <Btn editor={editor} title="Clear formatting" onClick={() => chain().unsetAllMarks().clearNodes().run()}>
          <Icon name="eraser" size={15} />
        </Btn>
      </div>
      <div className="tb-group">
        <Btn editor={editor} title="Bulleted list" active={editor.isActive('bulletList')} onClick={() => chain().toggleBulletList().run()}>
          <Icon name="list" size={15} />
        </Btn>
        <Btn editor={editor} title="Numbered list" active={editor.isActive('orderedList')} onClick={() => chain().toggleOrderedList().run()}>
          <Icon name="listOrdered" size={15} />
        </Btn>
        <Btn editor={editor} title="Decrease indent" disabled={!inList} onClick={() => chain().liftListItem('listItem').run()}>
          <Icon name="outdent" size={15} />
        </Btn>
        <Btn editor={editor} title="Increase indent" disabled={!inList || !editor.can().sinkListItem('listItem')} onClick={() => chain().sinkListItem('listItem').run()}>
          <Icon name="indent" size={15} />
        </Btn>
        <Btn editor={editor} title="Quote" active={editor.isActive('blockquote')} onClick={() => chain().toggleBlockquote().run()}>
          <Icon name="quote" size={15} />
        </Btn>
      </div>
      <div className="tb-group">
        {(['left', 'center', 'right', 'justify'] as const).map((a) => (
          <Btn key={a} editor={editor} title={`Align ${a}`} active={editor.isActive({ textAlign: a })} onClick={() => chain().setTextAlign(a).run()}>
            <Icon name={`align${a[0].toUpperCase()}${a.slice(1)}`} size={15} />
          </Btn>
        ))}
      </div>
      <div className="tb-group">
        <Btn editor={editor} title="Link" active={editor.isActive('link')} onClick={editLink}>
          <Icon name="link" size={15} />
        </Btn>
        <Btn editor={editor} title="Insert picture" onClick={() => imageInput.current?.click()}>
          <Icon name="image" size={15} />
        </Btn>
        <input
          ref={imageInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            insertImages(editor, Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <Menu
          trigger={(open) => (
            <button type="button" title="Table" aria-label="Table" onMouseDown={(e) => e.preventDefault()} onClick={open} className={inTable ? 'active' : ''}>
              <Icon name="table" size={15} />
            </button>
          )}
        >
          {(close) => {
            const act = (fn: () => boolean) => () => (fn(), close());
            return inTable ? (
              <>
                <button onClick={act(() => chain().addRowBefore().run())}>Insert row above</button>
                <button onClick={act(() => chain().addRowAfter().run())}>Insert row below</button>
                <button onClick={act(() => chain().addColumnBefore().run())}>Insert column left</button>
                <button onClick={act(() => chain().addColumnAfter().run())}>Insert column right</button>
                <button onClick={act(() => chain().toggleHeaderRow().run())}>Toggle header row</button>
                <hr />
                <button onClick={act(() => chain().deleteRow().run())}>Delete row</button>
                <button onClick={act(() => chain().deleteColumn().run())}>Delete column</button>
                <button className="danger" onClick={act(() => chain().deleteTable().run())}>
                  Delete table
                </button>
              </>
            ) : (
              <>
                {[
                  [2, 2],
                  [3, 3],
                  [4, 3],
                  [5, 4],
                ].map(([c, r]) => (
                  <button key={`${c}x${r}`} onClick={act(() => chain().insertTable({ rows: r, cols: c, withHeaderRow: false }).run())}>
                    Insert {c} × {r} table
                  </button>
                ))}
              </>
            );
          }}
        </Menu>
        <Btn editor={editor} title="Horizontal line" onClick={() => chain().setHorizontalRule().run()}>
          <Icon name="minus" size={15} />
        </Btn>
        {onAttach && (
          <Btn editor={editor} title="Attach files" onClick={onAttach}>
            <Icon name="paperclip" size={15} />
          </Btn>
        )}
      </div>
    </div>
  );
}

export const RichEditor = forwardRef<
  RichEditorHandle,
  { initialHtml: string; onChange: () => void; onFiles: (files: File[]) => void; onAttach?: () => void; autoFocus?: boolean }
>(function RichEditor({ initialHtml, onChange, onFiles, onAttach, autoFocus }, ref) {
  const [, force] = useState(0);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }),
      TextStyleKit,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Subscript,
      Superscript,
      Image.configure({ inline: true, allowBase64: true }),
      TableKit.configure({ table: { resizable: false } }),
      Placeholder.configure({ placeholder: 'Write your message…' }),
    ],
    content: initialHtml,
    autofocus: autoFocus ? 'start' : false,
    shouldRerenderOnTransaction: true,
    onUpdate: () => onChange(),
    editorProps: {
      attributes: { class: 'editor', 'aria-label': 'Message body', role: 'textbox', 'aria-multiline': 'true' },
      // Pasted or dropped images go inline; other dropped files become attachments.
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        const images = files.filter((f) => f.type.startsWith('image/'));
        if (!images.length) return false;
        if (editorRef.current) insertImages(editorRef.current, images);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        if (!files.length) return false;
        const images = files.filter((f) => f.type.startsWith('image/'));
        if (images.length && editorRef.current) insertImages(editorRef.current, images);
        const others = files.filter((f) => !f.type.startsWith('image/'));
        if (others.length) onFiles(others);
        return true;
      },
    },
  });
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  useImperativeHandle(
    ref,
    () => ({
      getHTML: () => editor?.getHTML() ?? '',
      getText: () => editor?.getText({ blockSeparator: '\n' }) ?? '',
      setHTML: (html: string) => {
        editor?.commands.setContent(html);
        force((n) => n + 1);
      },
      focus: () => editor?.commands.focus('start'),
    }),
    [editor],
  );

  if (!editor) return null;
  return (
    <div className="rich-editor">
      <Toolbar editor={editor} onAttach={onAttach} />
      <EditorContent editor={editor} className="editor-scroll" style={{ fontFamily: DEFAULT_FONT, fontSize: DEFAULT_SIZE }} />
    </div>
  );
});

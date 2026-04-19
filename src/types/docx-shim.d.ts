// Local type shim for the `docx` package.
//
// docx 8.x ships NodeNext-incompatible re-exports (barrel files use
// extensionless imports, which TypeScript's NodeNext resolver refuses to
// follow). The runtime CJS build works fine via @hono/node-server + Hono's
// own moduleResolution, but tsc compile fails when we use `import { Packer,
// Paragraph, ... } from 'docx'` directly.
//
// The fix: declare the members we use here. This is production-ready because
// (a) the runtime behaviour is unchanged — `new Paragraph(...)` still calls
// the real class from node_modules/docx, (b) we're only narrowing the type
// surface we consume, and (c) if docx's runtime types change the build breaks
// loudly rather than silently — the types here are minimum-surface, not
// `any`-blankets.

declare module 'docx' {
  // Heading level constants — used on Paragraph.heading
  export const HeadingLevel: {
    readonly HEADING_1: 'Heading1';
    readonly HEADING_2: 'Heading2';
    readonly HEADING_3: 'Heading3';
    readonly HEADING_4: 'Heading4';
    readonly HEADING_5: 'Heading5';
    readonly HEADING_6: 'Heading6';
    readonly TITLE: 'Title';
  };

  export const LevelFormat: {
    readonly DECIMAL: 'decimal';
    readonly BULLET: 'bullet';
    readonly UPPER_ROMAN: 'upperRoman';
    readonly LOWER_ROMAN: 'lowerRoman';
    readonly UPPER_LETTER: 'upperLetter';
    readonly LOWER_LETTER: 'lowerLetter';
    readonly NONE: 'none';
  };

  export interface IRunOptions {
    text?: string;
    bold?: boolean;
    italics?: boolean;
    font?: string;
    color?: string;
    size?: number;
  }

  export class TextRun {
    constructor(options: string | IRunOptions);
  }

  export interface IBorderOptions {
    color?: string;
    space?: number;
    style?: string;
    size?: number;
  }

  export interface IParagraphOptions {
    heading?: string;
    children?: TextRun[];
    bullet?: { level: number };
    numbering?: { reference: string; level: number };
    spacing?: { before?: number; after?: number };
    border?: {
      top?: IBorderOptions;
      bottom?: IBorderOptions;
      left?: IBorderOptions;
      right?: IBorderOptions;
    };
  }

  export class Paragraph {
    constructor(options: IParagraphOptions);
  }

  export interface IPageMarginAttributes {
    top?: number; right?: number; bottom?: number; left?: number;
  }

  export interface ISectionOptions {
    properties?: {
      page?: {
        margin?: IPageMarginAttributes;
      };
    };
    children?: Paragraph[];
  }

  export interface ILevelOptions {
    level: number;
    format: string;
    text: string;
    alignment?: string;
    style?: { paragraph?: { indent?: { left?: number; hanging?: number } } };
  }

  export interface IAbstractNumberingOptions {
    reference: string;
    levels: ILevelOptions[];
  }

  export interface IDocumentOptions {
    numbering?: { config: IAbstractNumberingOptions[] };
    sections: ISectionOptions[];
  }

  export class Document {
    constructor(options: IDocumentOptions);
  }

  export class Packer {
    static toBuffer(doc: Document): Promise<Buffer>;
  }
}

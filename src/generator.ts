export type StyleExt = 'css' | 'scss';
export type PropKind = 'inputs' | 'outputs' | 'models';
export type NodeKind = 'component' | 'service';

export interface Prop {
  name: string;
  type: string;
  required?: boolean;
}

export interface ComponentNode {
  id: string;
  /** Missing in state saved before services existed, which means 'component'. */
  kind?: NodeKind;
  name: string;
  expanded?: boolean;
  inputs: Prop[];
  outputs: Prop[];
  models: Prop[];
  children: ComponentNode[];
}

export interface EditorState {
  target: string;
  style: StyleExt;
  tree: ComponentNode[];
  selectedId?: string | null;
}

export interface PlannedFile {
  /** Path relative to the target folder, always separated by '/'. */
  relativePath: string;
  content: string;
}

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const IDENT = /^[A-Za-z_$][\w$]*$/;

const KINDS: { key: PropKind; fn: 'input' | 'output' | 'model'; label: string }[] = [
  { key: 'inputs', fn: 'input', label: 'input' },
  { key: 'outputs', fn: 'output', label: 'output' },
  { key: 'models', fn: 'model', label: 'model' },
];

function toPascalCase(kebab: string): string {
  return kebab
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function toClassName(kebab: string): string {
  return toPascalCase(kebab) + 'Component';
}

/** `user-data` and `user-data-service` both name the same service. */
export function toServiceFileName(name: string): string {
  const trimmed = name.trim();
  return trimmed.endsWith('-service') ? trimmed.slice(0, -'-service'.length) : trimmed;
}

export function toServiceClassName(name: string): string {
  return toPascalCase(toServiceFileName(name)) + 'Service';
}

export function toServiceFieldName(name: string): string {
  const pascal = toPascalCase(toServiceFileName(name));
  return pascal.charAt(0).toLowerCase() + pascal.slice(1) + 'Service';
}

export const isService = (node: ComponentNode) => node.kind === 'service';
const componentsOf = (node: ComponentNode) => (node.children ?? []).filter((child) => !isService(child));
const servicesOf = (node: ComponentNode) => (node.children ?? []).filter(isService);

/** Rows left completely empty in the editor are ignored rather than reported. */
function propsOf(node: ComponentNode, kind: PropKind): Prop[] {
  return (node[kind] ?? []).filter((p) => p.name.trim() || p.type.trim());
}

export function countNodes(tree: ComponentNode[]): { components: number; services: number } {
  const counts = { components: 0, services: 0 };
  const walk = (list: ComponentNode[]) => {
    for (const node of list) {
      counts[isService(node) ? 'services' : 'components']++;
      walk(node.children ?? []);
    }
  };
  walk(tree);
  return counts;
}

export function validateTree(tree: ComponentNode[]): string[] {
  const errors: string[] = [];

  const walk = (list: ComponentNode[], path: string[]) => {
    const components = new Set<string>();
    const services = new Set<string>();
    for (const node of list) {
      const label = [...path, node.name || '(bez názvu)'].join(' / ');

      if (isService(node)) {
        if (!node.name.trim()) {
          errors.push(`Service bez názvu: ${label}`);
        } else if (!KEBAB.test(node.name.trim()) || node.name.trim() === 'service') {
          errors.push(`Název service není kebab-case: ${label}`);
        } else if (services.has(toServiceClassName(node.name))) {
          errors.push(`Duplicitní service na stejné úrovni: ${label}`);
        }
        services.add(toServiceClassName(node.name));
        if (!path.length) {
          errors.push(`Service musí být vnořená v komponentě: ${label}`);
        }
        continue;
      }

      if (!node.name) {
        errors.push(`Komponenta bez názvu: ${label}`);
      } else if (!KEBAB.test(node.name)) {
        errors.push(`Název není kebab-case: ${label}`);
      } else if (components.has(node.name)) {
        errors.push(`Duplicitní název na stejné úrovni: ${label}`);
      }
      components.add(node.name);

      const fields = new Set(servicesOf(node).map((service) => toServiceFieldName(service.name)));
      for (const kind of KINDS) {
        for (const prop of propsOf(node, kind.key)) {
          const name = prop.name.trim();
          if (!IDENT.test(name)) {
            errors.push(`Neplatný název ${kind.label} "${name}" v ${label}`);
          } else if (fields.has(name)) {
            errors.push(`Duplicitní vlastnost "${name}" v ${label}`);
          }
          fields.add(name);
        }
      }

      walk(node.children ?? [], [...path, node.name]);
    }
  };

  walk(tree, []);
  return errors;
}

export function planFiles(tree: ComponentNode[], options: { style: StyleExt }): PlannedFile[] {
  const files: PlannedFile[] = [];

  const walk = (list: ComponentNode[], dir: string) => {
    for (const node of list) {
      const folder = dir ? `${dir}/${node.name}` : node.name;
      const base = `${folder}/${node.name}.component`;
      files.push(
        { relativePath: `${base}.ts`, content: renderTs(node, options) },
        { relativePath: `${base}.html`, content: renderHtml(node) },
        { relativePath: `${base}.${options.style}`, content: '' },
      );
      for (const service of servicesOf(node)) {
        files.push({
          relativePath: `${folder}/services/${toServiceFileName(service.name)}.service.ts`,
          content: renderService(service),
        });
      }
      walk(componentsOf(node), `${folder}/components`);
    }
  };

  walk(tree.filter((node) => !isService(node)), '');
  return files;
}

function renderField(prop: Prop, fn: 'input' | 'output' | 'model'): string {
  const type = prop.type.trim();
  const generic = type ? `<${type}>` : '';
  const required = prop.required && fn !== 'output' ? '.required' : '';
  return `public readonly ${prop.name.trim()} = ${fn}${required}${generic}();`;
}

function renderList(key: string, items: string[]): string[] {
  return items.length ? [`  ${key}: [`, ...items.map((item) => `    ${item},`), '  ],'] : [`  ${key}: [],`];
}

export function renderTs(node: ComponentNode, options: { style: StyleExt }): string {
  const children = componentsOf(node);
  const services = servicesOf(node);
  const className = toClassName(node.name);

  const groups = [
    services.map((service) => `private readonly ${toServiceFieldName(service.name)} = inject(${toServiceClassName(service.name)});`),
    ...KINDS.map((kind) => propsOf(node, kind.key).map((prop) => renderField(prop, kind.fn))),
  ].filter((group) => group.length);

  const ngImports = [
    'Component',
    ...(services.length ? ['inject'] : []),
    ...KINDS.filter((kind) => propsOf(node, kind.key).length).map((kind) => kind.fn),
  ];

  const lines = [`import { ${ngImports.join(', ')} } from '@angular/core';`];
  for (const child of children) {
    lines.push(`import { ${toClassName(child.name)} } from './components/${child.name}/${child.name}.component';`);
  }
  for (const service of services) {
    lines.push(`import { ${toServiceClassName(service.name)} } from './services/${toServiceFileName(service.name)}.service';`);
  }

  lines.push(
    '',
    '@Component({',
    `  selector: '${node.name}',`,
    '  standalone: true,',
    ...renderList('imports', children.map((child) => toClassName(child.name))),
    ...(services.length ? renderList('providers', services.map((service) => toServiceClassName(service.name))) : []),
    `  templateUrl: './${node.name}.component.html',`,
    `  styleUrl: './${node.name}.component.${options.style}',`,
    '})',
  );

  if (!groups.length) {
    lines.push(`export class ${className} {}`);
  } else {
    lines.push(`export class ${className} {`);
    groups.forEach((group, i) => {
      if (i) {
        lines.push('');
      }
      for (const line of group) {
        lines.push(`  ${line}`);
      }
    });
    lines.push('}');
  }

  return lines.join('\n') + '\n';
}

export function renderService(service: ComponentNode): string {
  return [
    `import { Injectable } from '@angular/core';`,
    '',
    '@Injectable()',
    `export class ${toServiceClassName(service.name)} {}`,
    '',
  ].join('\n');
}

export function renderHtml(node: ComponentNode): string {
  const children = componentsOf(node);
  if (!children.length) {
    return `<div class="${node.name}"></div>\n`;
  }
  const lines = [`<div class="${node.name}">`];
  children.forEach((child, i) => {
    if (i) {
      lines.push('');
    }
    lines.push(...renderChildTag(child).map((line) => `  ${line}`));
  });
  lines.push('</div>');
  return lines.join('\n') + '\n';
}

/** Self-closing tag with every required input/model and every output, bound without a value. */
function renderChildTag(child: ComponentNode): string[] {
  const bindings = [
    ...propsOf(child, 'inputs').filter((p) => p.required).map((p) => `[${p.name.trim()}]=""`),
    ...propsOf(child, 'models').filter((p) => p.required).map((p) => `[(${p.name.trim()})]=""`),
    ...propsOf(child, 'outputs').map((p) => `(${p.name.trim()})=""`),
  ];
  const classAttr = `class="${child.name}"`;
  if (!bindings.length) {
    return [`<${child.name} ${classAttr} />`];
  }
  return [`<${child.name}`, ...[classAttr, ...bindings].map((attr) => `  ${attr}`), '/>'];
}

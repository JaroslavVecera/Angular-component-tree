<div align="center">

# Angular Component Tree

**Sketch a tree of Angular components and services in a VS Code side panel, then generate all of it in one click.**

[![Repo size](https://img.shields.io/github/repo-size/JaroslavVecera/Angular-component-tree?style=flat-square)](https://github.com/JaroslavVecera/Angular-component-tree)
[![Last commit](https://img.shields.io/github/last-commit/JaroslavVecera/Angular-component-tree?style=flat-square)](https://github.com/JaroslavVecera/Angular-component-tree/commits)
[![Latest release](https://img.shields.io/github/v/release/JaroslavVecera/Angular-component-tree?style=flat-square)](https://github.com/JaroslavVecera/Angular-component-tree/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/JaroslavVecera/Angular-component-tree/total?style=flat-square)](https://github.com/JaroslavVecera/Angular-component-tree/releases)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.85-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![Angular](https://img.shields.io/badge/Angular-signals-DD0031?style=flat-square&logo=angular&logoColor=white)](https://angular.dev/guide/signals)

</div>

---

## Why

Scaffolding a feature usually means running `ng generate` a dozen times, moving folders around, and then wiring every child into its parent by hand: imports, selectors, required inputs. With Angular Component Tree you design the whole hierarchy first, the way you would in a file explorer, and generate it all at once.

## Features

- **Tree editor in the Activity Bar.** Add, nest, rename and delete components with keyboard shortcuts that work like an outliner.
- **Signal-based API.** Define `input()`, `output()` and `model()` for each component in a three-column panel (name + type, optional `.required`).
- **Parents are wired automatically.** Child components are imported into the parent and placed into its template as self-closing tags, with every required input, required model and output already bound.
- **Component-scoped services.** Services go into the component's `providers` (not `providedIn: 'root'`) and are injected with `inject()`.
- **CSS or SCSS** with a single checkbox.
- **Friendly target picker.** Defaults to `src/app`. Browse workspace folders in a quick pick, open the system dialog, or right-click a folder in the Explorer.
- **Safe generation.** Names are validated live, and before anything is written you choose whether to overwrite or skip existing files.

## How it works

1. Click the **Angular Component Tree** icon in the Activity Bar.
2. Choose the **target folder**. It starts at `src/app` (or the workspace root). Use **Browse** to walk through existing folders, or type the name of a new subfolder.
3. Build the tree. Component and service names are written in **kebab-case**.

   | Key / button | Action |
   | --- | --- |
   | <kbd>Enter</kbd> | Add a sibling below |
   | <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> | Indent / outdent |
   | <kbd>↑</kbd> / <kbd>↓</kbd> | Move between rows |
   | <kbd>Backspace</kbd> on an empty name | Delete the row |
   | **+** | Add a nested component |
   | **+S** | Add a nested service |

4. Click a component to open its **Inputs / Outputs / Models** panel.
5. Press **Generate**. The whole tree is written in one go.

### Example

A tree like this:

```
user-list
├─ user-data        (service)
├─ user-row         inputs: user: User (required) · outputs: selected: number
└─ user-filter
```

generates:

```
user-list/
├─ user-list.component.ts | .html | .scss
├─ services/
│  └─ user-data.service.ts
└─ components/
   ├─ user-row/
   │  └─ user-row.component.ts | .html | .scss
   └─ user-filter/
      └─ user-filter.component.ts | .html | .scss
```

<details>
<summary><b>user-list.component.ts</b></summary>

```ts
import { Component, inject } from '@angular/core';
import { UserRowComponent } from './components/user-row/user-row.component';
import { UserFilterComponent } from './components/user-filter/user-filter.component';
import { UserDataService } from './services/user-data.service';

@Component({
  selector: 'user-list',
  standalone: true,
  imports: [
    UserRowComponent,
    UserFilterComponent,
  ],
  providers: [
    UserDataService,
  ],
  templateUrl: './user-list.component.html',
  styleUrl: './user-list.component.scss',
})
export class UserListComponent {
  private readonly userDataService = inject(UserDataService);
}
```

</details>

<details>
<summary><b>user-list.component.html</b></summary>

```html
<div class="user-list">
  <user-row
    class="user-row"
    [user]=""
    (selected)=""
  />

  <user-filter class="user-filter" />
</div>
```

</details>

<details>
<summary><b>user-row.component.ts</b></summary>

```ts
import { Component, input, output } from '@angular/core';

@Component({
  selector: 'user-row',
  standalone: true,
  imports: [],
  templateUrl: './user-row.component.html',
  styleUrl: './user-row.component.scss',
})
export class UserRowComponent {
  public readonly user = input.required<User>();

  public readonly selected = output<number>();
}
```

</details>

<details>
<summary><b>user-data.service.ts</b></summary>

```ts
import { Injectable } from '@angular/core';

@Injectable()
export class UserDataService {}
```

</details>

> [!NOTE]
> The bindings in the parent template (`[user]=""`) are intentionally left empty for you to fill in. Angular won't compile the template until you do.

## Installation

### From a GitHub release (recommended)

1. Download the latest `angular-component-tree-x.y.z.vsix` from [**Releases**](https://github.com/JaroslavVecera/Angular-component-tree/releases/latest).
2. Install it:
   - **VS Code UI:** Extensions view → `⋯` menu → **Install from VSIX…** → pick the file, or
   - **Terminal:**
     ```bash
     code --install-extension angular-component-tree-x.y.z.vsix
     ```
3. Reload the window if prompted.

### Build from source

Requires [Node.js](https://nodejs.org/) 18+.

```bash
git clone https://github.com/JaroslavVecera/Angular-component-tree.git
cd Angular-component-tree
npm install
npm run package                     # produces angular-component-tree-<version>.vsix
code --install-extension angular-component-tree-*.vsix
```

To debug, open the folder in VS Code and press <kbd>F5</kbd>. A new Extension Development Host window starts with the extension loaded.

## Releasing

Push a version tag and GitHub Actions builds the `.vsix` and attaches it to a new release:

```bash
npm version patch          # bumps package.json and creates the v* tag
git push --follow-tags
```
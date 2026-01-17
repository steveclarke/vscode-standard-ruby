# Multi-Root Workspace Test Fixture

This fixture demonstrates and tests multi-root workspace support for the Standard Ruby extension.

## The Problem This Solves

Without multi-root support, the extension uses the **first** workspace folder's Standard Ruby configuration for **all** files. This causes false positives when different folders have different configurations.

In this example:
- `app-rails/` uses `standard-rails` (which includes Rails-specific cops like `Rails/Output`)
- `cli-tool/` uses plain `standard` (no Rails cops)

The Rails folder is named `app-rails` so it comes first alphabetically. This is important because without multi-root support, the **first** folder's config is used for all files.

**Before the fix:** The CLI tool's `puts` statements in `lib/` would trigger `Rails/Output: Do not write to stdout` errors because the Rails config (from app-rails) was applied to all files.

**After the fix:** Each folder gets its own language server with the correct configuration.

## How to Test

### Setup

1. Install dependencies in both folders:
   ```bash
   cd app-rails && bundle install
   cd ../cli-tool && bundle install
   ```

2. Run the extension in development mode:
   - Open the vscode-standard-ruby project in VS Code
   - Press F5 to launch the Extension Development Host

3. In the Extension Development Host, open this workspace:
   - File > Open Workspace from File...
   - Select `test-fixtures/multi-root-demo/multi-root-demo.code-workspace`

### What to Verify

1. **Check the Output panel** (View > Output > Standard Ruby):
   - You should see TWO language servers starting:
     ```
     Starting language server for "app-rails": ...
     Starting language server for "cli-tool": ...
     ```

2. **Open `cli-tool/lib/cli.rb`**:
   - The `puts` statements should NOT show any errors
   - If you see `Rails/Output: Do not write to stdout`, multi-root support is broken

3. **Open `app-rails/app/controllers/users_controller.rb`**:
   - Should lint correctly with Rails cops
   - No unexpected errors

4. **Test folder add/remove** (optional):
   - Remove one folder from the workspace
   - Verify its language server stops
   - Add it back
   - Verify its language server restarts

## File Structure

```
multi-root-demo/
├── multi-root-demo.code-workspace   # VS Code workspace file
├── README.md                         # This file
├── app-rails/
│   ├── .standard.yml                 # Uses standard-rails plugin
│   ├── Gemfile
│   └── app/controllers/users_controller.rb
└── cli-tool/
    ├── .standard.yml                 # Plain standard (no Rails)
    ├── Gemfile
    └── lib/cli.rb                     # Has puts statements (valid for CLI)
```

## Why lib/ Instead of bin/?

The `Rails/Output` cop only checks files in specific directories (`app/`, `config/`, `db/`, `lib/`). Files in `bin/` are not checked by this cop. That's why the test file is in `lib/cli/ui.rb` - it matches the pattern the cop looks for.

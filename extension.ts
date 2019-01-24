/**
 * Extension.ts is a lightweight wrapper around ModeHandler. It converts key
 * events to their string names and passes them on to ModeHandler via
 * handleKeyEvent().
 */
import './src/actions/include-all';

import * as _ from 'lodash';
import * as vscode from 'vscode';

import { CompositionState } from './src/state/compositionState';
import { EditorIdentity } from './src/editorIdentity';
import { Globals } from './src/globals';
import { Jump } from './src/jumps/jump';
import { ModeHandler } from './src/mode/modeHandler';
import { ModeHandlerMap } from './src/mode/modeHandlerMap';
import { ModeName } from './src/mode/mode';
import { Notation } from './src/configuration/notation';
import { Position } from './src/common/motion/position';
import { StatusBar } from './src/statusBar';
import { VsCodeContext } from './src/util/vscode-context';
import { commandLine } from './src/cmd_line/commandLine';
import { configuration } from './src/configuration/configuration';
import { configurationValidator } from './src/configuration/configurationValidator';
import { globalState } from './src/state/globalState';
import { logger } from './src/util/logger';
import { taskQueue } from './src/taskQueue';

let extensionContext: vscode.ExtensionContext;
let previousActiveEditorId: EditorIdentity | null = null;
let lastClosedModeHandler: ModeHandler | null = null;

interface ICodeKeybinding {
  after?: string[];
  commands?: { command: string; args: any[] }[];
}

export async function getAndUpdateModeHandler(forceSyncAndUpdate = false): Promise<ModeHandler> {
  const activeEditorId = new EditorIdentity(vscode.window.activeTextEditor);

  let [curHandler, isNew] = await ModeHandlerMap.getOrCreate(activeEditorId.toString());
  if (isNew) {
    extensionContext.subscriptions.push(curHandler);
  }

  curHandler.vimState.editor = vscode.window.activeTextEditor!;

  if (
    forceSyncAndUpdate ||
    !previousActiveEditorId ||
    !previousActiveEditorId.isEqual(activeEditorId)
  ) {
    await curHandler.syncCursors();
    await curHandler.updateView(curHandler.vimState, { drawSelection: false, revealRange: false });
  }

  previousActiveEditorId = activeEditorId;

  if (curHandler.vimState.focusChanged) {
    curHandler.vimState.focusChanged = false;

    if (previousActiveEditorId) {
      const prevHandler = ModeHandlerMap.get(previousActiveEditorId.toString());
      prevHandler!.vimState.focusChanged = true;
    }
  }

  return curHandler;
}

export async function activate(context: vscode.ExtensionContext) {
  logger.debug('Extension: activating vscodevim.');

  extensionContext = context;
  extensionContext.subscriptions.push(StatusBar);

  logger.debug('Extension: registering event handlers.');

  // workspace events
  registerEventListener(
    context,
    vscode.workspace.onDidChangeConfiguration,
    () => {
      logger.debug('onDidChangeConfiguration: reloading configuration');
      configuration.reload();
    },
    false
  );

  registerEventListener(context, vscode.workspace.onDidChangeTextDocument, async event => {
    const textWasDeleted = changeEvent =>
      changeEvent.contentChanges.length === 1 &&
      changeEvent.contentChanges[0].text === '' &&
      changeEvent.contentChanges[0].range.start.line !==
        changeEvent.contentChanges[0].range.end.line;

    const textWasAdded = changeEvent =>
      changeEvent.contentChanges.length === 1 &&
      (changeEvent.contentChanges[0].text === '\n' ||
        changeEvent.contentChanges[0].text === '\r\n') &&
      changeEvent.contentChanges[0].range.start.line ===
        changeEvent.contentChanges[0].range.end.line;

    if (textWasDeleted(event)) {
      globalState.jumpTracker.handleTextDeleted(event.document, event.contentChanges[0].range);
    } else if (textWasAdded(event)) {
      globalState.jumpTracker.handleTextAdded(
        event.document,
        event.contentChanges[0].range,
        event.contentChanges[0].text
      );
    }

    // Change from vscode editor should set document.isDirty to true but they initially don't!
    // There is a timing issue in vscode codebase between when the isDirty flag is set and
    // when registered callbacks are fired. https://github.com/Microsoft/vscode/issues/11339
    const contentChangeHandler = (modeHandler: ModeHandler) => {
      if (modeHandler.vimState.currentMode === ModeName.Insert) {
        if (modeHandler.vimState.historyTracker.currentContentChanges === undefined) {
          modeHandler.vimState.historyTracker.currentContentChanges = [];
        }

        modeHandler.vimState.historyTracker.currentContentChanges = modeHandler.vimState.historyTracker.currentContentChanges.concat(
          event.contentChanges
        );
      }
    };

    if (Globals.isTesting && Globals.mockModeHandler) {
      contentChangeHandler(Globals.mockModeHandler as ModeHandler);
    } else {
      _.filter(
        ModeHandlerMap.getAll(),
        modeHandler => modeHandler.vimState.identity.fileName === event.document.fileName
      ).forEach(modeHandler => {
        contentChangeHandler(modeHandler);
      });
    }

    setTimeout(() => {
      if (!event.document.isDirty && !event.document.isUntitled && event.contentChanges.length) {
        handleContentChangedFromDisk(event.document);
      }
    }, 0);
  });

  registerEventListener(
    context,
    vscode.workspace.onDidCloseTextDocument,
    async () => {
      const documents = vscode.workspace.textDocuments;

      // Delete modehandler once all tabs of this document have been closed
      for (let editorIdentity of ModeHandlerMap.getKeys()) {
        const modeHandler = ModeHandlerMap.get(editorIdentity);

        if (
          modeHandler == null ||
          modeHandler.vimState.editor === undefined ||
          documents.indexOf(modeHandler.vimState.editor.document) === -1
        ) {
          ModeHandlerMap.delete(editorIdentity);
        }
      }
    },
    false
  );

  // window events
  registerEventListener(
    context,
    vscode.window.onDidChangeActiveTextEditor,
    async () => {
      const mhPrevious: ModeHandler | null = previousActiveEditorId
        ? ModeHandlerMap.get(previousActiveEditorId.toString())
        : null;
      // Track the closed editor so we can use it the next time an open event occurs.
      // When vscode changes away from a temporary file, onDidChangeActiveTextEditor first twice.
      // First it fires when leaving the closed editor. Then onDidCloseTextDocument first, and we delete
      // the old ModeHandler. Then a new editor opens.
      //
      // This also applies to files that are merely closed, which allows you to jump back to that file similarly
      // once a new file is opened.
      lastClosedModeHandler = mhPrevious || lastClosedModeHandler;

      if (vscode.window.activeTextEditor === undefined) {
        return;
      }

      taskQueue.enqueueTask(async () => {
        if (vscode.window.activeTextEditor !== undefined) {
          const mh: ModeHandler = await getAndUpdateModeHandler(true);

          await VsCodeContext.Set('vim.mode', ModeName[mh.vimState.currentMode]);

          await mh.updateView(mh.vimState, { drawSelection: false, revealRange: false });

          globalState.jumpTracker.handleFileJump(
            lastClosedModeHandler ? Jump.fromStateNow(lastClosedModeHandler.vimState) : null,
            Jump.fromStateNow(mh.vimState)
          );
        }
      });
    },
    true,
    true
  );

  registerEventListener(
    context,
    vscode.window.onDidChangeTextEditorSelection,
    async (e: vscode.TextEditorSelectionChangeEvent) => {
      const mh = await getAndUpdateModeHandler();

      if (mh.vimState.focusChanged) {
        mh.vimState.focusChanged = false;
        return;
      }

      if (mh.currentMode.name === ModeName.EasyMotionMode) {
        return;
      }

      taskQueue.enqueueTask(
        () => mh.handleSelectionChange(e),
        undefined,
        /**
         * We don't want these to become backlogged! If they do, we'll update
         * the selection to an incorrect value and see a jittering cursor.
         */
        true
      );
    },
    true,
    true
  );

  const compositionState = new CompositionState();

  // override vscode commands
  overrideCommand(context, 'type', async args => {
    taskQueue.enqueueTask(async () => {
      const mh = await getAndUpdateModeHandler();

      if (compositionState.isInComposition) {
        compositionState.composingText += args.text;
      } else {
        await mh.handleKeyEvent(args.text);
      }
    });
  });

  overrideCommand(context, 'replacePreviousChar', async args => {
    taskQueue.enqueueTask(async () => {
      const mh = await getAndUpdateModeHandler();

      if (compositionState.isInComposition) {
        compositionState.composingText =
          compositionState.composingText.substr(
            0,
            compositionState.composingText.length - args.replaceCharCnt
          ) + args.text;
      } else {
        await vscode.commands.executeCommand('default:replacePreviousChar', {
          text: args.text,
          replaceCharCnt: args.replaceCharCnt,
        });
        mh.vimState.cursorPosition = Position.FromVSCodePosition(
          mh.vimState.editor.selection.start
        );
        mh.vimState.cursorStartPosition = Position.FromVSCodePosition(
          mh.vimState.editor.selection.start
        );
      }
    });
  });

  overrideCommand(context, 'compositionStart', async () => {
    taskQueue.enqueueTask(async () => {
      const mh = await getAndUpdateModeHandler();
      if (mh.vimState.currentMode !== ModeName.Insert) {
        compositionState.isInComposition = true;
      }
    });
  });

  overrideCommand(context, 'compositionEnd', async () => {
    taskQueue.enqueueTask(async () => {
      const mh = await getAndUpdateModeHandler();
      if (mh.vimState.currentMode !== ModeName.Insert) {
        let text = compositionState.composingText;
        compositionState.reset();
        mh.handleMultipleKeyEvents(text.split(''));
      }
    });
  });

  // register extension commands
  registerCommand(context, 'vim.showQuickpickCmdLine', async () => {
    const mh = await getAndUpdateModeHandler();
    await commandLine.PromptAndRun('', mh.vimState);
    mh.updateView(mh.vimState);
  });

  registerCommand(context, 'vim.remap', async (args: ICodeKeybinding) => {
    taskQueue.enqueueTask(async () => {
      const mh = await getAndUpdateModeHandler();
      if (args.after) {
        for (const key of args.after) {
          await mh.handleKeyEvent(Notation.NormalizeKey(key, configuration.leader));
        }
        return;
      }

      if (args.commands) {
        for (const command of args.commands) {
          // Check if this is a vim command by looking for :
          if (command.command.slice(0, 1) === ':') {
            await commandLine.Run(command.command.slice(1, command.command.length), mh.vimState);
            mh.updateView(mh.vimState);
          } else {
            vscode.commands.executeCommand(command.command, command.args);
          }
        }
      }
    });
  });

  registerCommand(context, 'toggleVim', async () => {
    configuration.disableExtension = !configuration.disableExtension;
    toggleExtension(configuration.disableExtension, compositionState);
  });

  for (const boundKey of configuration.boundKeyCombinations) {
    registerCommand(context, boundKey.command, () => handleKeyEvent(`${boundKey.key}`));
  }

  // Initialize mode handler for current active Text Editor at startup.
  if (vscode.window.activeTextEditor) {
    let mh = await getAndUpdateModeHandler();
    mh.updateView(mh.vimState, { drawSelection: false, revealRange: false });
  }

  await Promise.all([
    commandLine.load(),
    globalState.load(),
    configurationValidator.initialize(),
    // This is called last because getAndUpdateModeHandler() will change cursor
    toggleExtension(configuration.disableExtension, compositionState),
  ]);
}

/**
 * Toggles the VSCodeVim extension between Enabled mode and Disabled mode. This
 * function is activated by calling the 'toggleVim' command from the Command Palette.
 *
 * @param isDisabled if true, sets VSCodeVim to Disabled mode; else sets to enabled mode
 */
async function toggleExtension(isDisabled: boolean, compositionState: CompositionState) {
  await VsCodeContext.Set('vim.active', !isDisabled);
  if (!vscode.window.activeTextEditor) {
    // This was happening in unit tests.
    // If activate was called and no editor window is open, we can't properly initialize.
    return;
  }
  let mh = await getAndUpdateModeHandler();
  if (isDisabled) {
    await mh.handleKeyEvent('<ExtensionDisable>');
    compositionState.reset();
    ModeHandlerMap.clear();
  } else {
    await mh.handleKeyEvent('<ExtensionEnable>');
  }
}

function overrideCommand(
  context: vscode.ExtensionContext,
  command: string,
  callback: (...args: any[]) => any
) {
  const disposable = vscode.commands.registerCommand(command, async args => {
    if (configuration.disableExtension) {
      return vscode.commands.executeCommand('default:' + command, args);
    }

    if (!vscode.window.activeTextEditor) {
      return;
    }

    if (
      vscode.window.activeTextEditor.document &&
      vscode.window.activeTextEditor.document.uri.toString() === 'debug:input'
    ) {
      return vscode.commands.executeCommand('default:' + command, args);
    }

    return callback(args);
  });
  context.subscriptions.push(disposable);
}

function registerCommand(
  context: vscode.ExtensionContext,
  command: string,
  callback: (...args: any[]) => any
) {
  const disposable = vscode.commands.registerCommand(command, async args => {
    if (!vscode.window.activeTextEditor) {
      return;
    }

    callback(args);
  });
  context.subscriptions.push(disposable);
}

function registerEventListener<T>(
  context: vscode.ExtensionContext,
  event: vscode.Event<T>,
  listener: (e: T) => any,
  exitOnExtensionDisable = true,
  exitOnTests = false
) {
  const disposable = event(async e => {
    if (exitOnExtensionDisable && configuration.disableExtension) {
      return;
    }

    if (exitOnTests && Globals.isTesting) {
      return;
    }

    listener(e);
  });
  context.subscriptions.push(disposable);
}

async function handleKeyEvent(key: string): Promise<void> {
  const mh = await getAndUpdateModeHandler();

  taskQueue.enqueueTask(async () => {
    await mh.handleKeyEvent(key);
  });
}

function handleContentChangedFromDisk(document: vscode.TextDocument): void {
  _.filter(
    ModeHandlerMap.getAll(),
    modeHandler => modeHandler.vimState.identity.fileName === document.fileName
  ).forEach(modeHandler => {
    modeHandler.vimState.historyTracker.clear();
  });
}

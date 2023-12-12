import * as vscode from 'vscode'
import * as path from 'path'
import { moveWebviewPanel } from '../utils/webview'
import { lw } from '../lw'
import type { TeXMathEnv } from '../types'

const logger = lw.log('Preview', 'Math')

export {
    serializer,
    toggle
}

type UpdateEvent = {
    type: 'edit',
    event: vscode.TextDocumentChangeEvent
} | {
    type: 'selection',
    event: vscode.TextEditorSelectionChangeEvent
}

function resourcesFolder(extensionRoot: string) {
    const folder = path.join(extensionRoot, 'resources', 'mathpreviewpanel')
    return vscode.Uri.file(folder)
}

class MathPreviewPanelSerializer implements vscode.WebviewPanelSerializer {
    deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        initializePanel(panel)
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [resourcesFolder(lw.extensionRoot)]
        }
        panel.webview.html = getHtml(panel.webview)
        logger.log('Math preview panel: restored')
        return Promise.resolve()
    }
}
const serializer = new MathPreviewPanelSerializer()

const state = {
    panel: undefined as vscode.WebviewPanel | undefined,
    prevEditTime: 0,
    prevDocumentUri: undefined as string | undefined,
    prevCursorPosition: undefined as vscode.Position | undefined,
    prevNewCommands: undefined as string | undefined,
}

function open() {
    const activeDocument = vscode.window.activeTextEditor?.document
    if (state.panel) {
        if (!state.panel.visible) {
            state.panel.reveal(undefined, true)
        }
        return
    }
    lw.preview.math.getColor()
    const panel = vscode.window.createWebviewPanel(
        'latex-workshop-mathpreview',
        'Math Preview',
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
        {
            enableScripts: true,
            localResourceRoots: [resourcesFolder(lw.extensionRoot)],
            retainContextWhenHidden: true
        }
    )
    initializePanel(panel)
    panel.webview.html = getHtml(panel.webview)
    const configuration = vscode.workspace.getConfiguration('latex-workshop')
    const editorGroup = configuration.get('mathpreviewpanel.editorGroup') as string
    if (activeDocument) {
        void moveWebviewPanel(panel, editorGroup)
    }
    logger.log('Math preview panel: opened')
}

function initializePanel(panel: vscode.WebviewPanel) {
    const disposable = vscode.Disposable.from(
        vscode.workspace.onDidChangeTextDocument( (event) => {
            void update({type: 'edit', event})
        }),
        vscode.window.onDidChangeTextEditorSelection( (event) => {
            void update({type: 'selection', event})
        })
    )
    state.panel = panel
    panel.onDidDispose(() => {
        disposable.dispose()
        clearCache()
        state.panel = undefined
        logger.log('Math preview panel: disposed')
    })
    panel.onDidChangeViewState((ev) => {
        if (ev.webviewPanel.visible) {
            void update()
        }
    })
    panel.webview.onDidReceiveMessage(() => {
        logger.log('Math preview panel: initialized')
        void update()
    })
}

function close() {
    state.panel?.dispose()
    state.panel = undefined
    clearCache()
    logger.log('Math preview panel: closed')
}

function toggle(action?: 'open' | 'close') {
    if (action) {
        if (action === 'open') {
            open()
        } else {
            close()
        }
    } else if (state.panel) {
        close()
    } else {
        open()
    }
}

function clearCache() {
    state.prevEditTime = 0
    state.prevDocumentUri = undefined
    state.prevCursorPosition = undefined
    state.prevNewCommands = undefined
}

function getHtml(webview: vscode.Webview) {
    const jsPath = vscode.Uri.file(path.join(lw.extensionRoot, './resources/mathpreviewpanel/mathpreview.js'))
    const jsPathSrc = webview.asWebviewUri(jsPath)
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; script-src ${webview.cspSource}; img-src data:; style-src 'unsafe-inline';">
        <meta charset="UTF-8">
        <style>
            body {
                padding: 0;
                margin: 0;
            }
            #math {
                padding-top: 35px;
                padding-left: 50px;
            }
        </style>
        <script src='${jsPathSrc}' defer></script>
    </head>
    <body>
        <div id="mathBlock"><img src="" id="math" /></div>
    </body>
    </html>`
}

async function update(ev?: UpdateEvent) {
    if (!state.panel || !state.panel.visible) {
        return
    }
    if (!vscode.workspace.getConfiguration('latex-workshop').get('mathpreviewpanel.cursor.enabled', false)) {
        if (ev?.type === 'edit') {
            state.prevEditTime = Date.now()
        } else if (ev?.type === 'selection') {
            if (Date.now() - state.prevEditTime < 100) {
                return
            }
        }
    }
    const editor = vscode.window.activeTextEditor
    const document = editor?.document
    if (!editor || !document?.languageId || !lw.file.hasTexLangId(document.languageId)) {
        clearCache()
        return
    }
    const documentUri = document.uri.toString()
    if (ev?.type === 'edit' && documentUri !== ev.event.document.uri.toString()) {
        return
    }
    const position = editor.selection.active
    const texMath = getTexMath(document, position)
    if (!texMath) {
        clearCache()
        return state.panel.webview.postMessage({type: 'mathImage', src: '' })
    }
    let cachedCommands: string | undefined
    if ( position.line === state.prevCursorPosition?.line && documentUri === state.prevDocumentUri ) {
        cachedCommands = state.prevNewCommands
    }
    if (vscode.workspace.getConfiguration('latex-workshop').get('mathpreviewpanel.cursor.enabled', false)) {
        await renderCursor(document, texMath)
    }
    const result = await lw.preview.math.generateSVG(texMath, cachedCommands).catch(() => undefined)
    if (!result) {
        return
    }
    state.prevDocumentUri = documentUri
    state.prevNewCommands = result.newCommands
    state.prevCursorPosition = position
    return state.panel.webview.postMessage({type: 'mathImage', src: result.svgDataUrl })
}

function getTexMath(document: vscode.TextDocument, position: vscode.Position) {
    const texMath = lw.preview.math.findMath(document, position)
    if (texMath) {
        if (texMath.envname !== '$') {
            return texMath
        }
        if (texMath.range.start.character !== position.character && texMath.range.end.character !== position.character) {
            return texMath
        }
    }
    return
}

async function renderCursor(document: vscode.TextDocument, tex: TeXMathEnv) {
    const s = await lw.preview.math.renderCursor(document, tex)
    tex.texString = s
}
import * as vscode from 'vscode'

import type { Extension } from '../../main'
import type { IProvider } from '../completion'
import { CmdEnvSuggestion } from './completerutils'
import { EnvSnippetType } from './environment'

export class Argument implements IProvider {

    constructor(private readonly extension: Extension) {}

    provideFrom(result: RegExpMatchArray, args: {document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext}): vscode.CompletionItem[] {
        if (result[1] === 'usepackage') {
            return this.providePackageOptions(args)
        }
        if (result[1] === 'documentclass') {
            return this.provideClassOptions(args)
        }
        const index = this.getArgumentIndex(result[2])
        const packages = this.extension.completer.package.getPackagesIncluded(args.document.languageId)
        let candidate: CmdEnvSuggestion | undefined
        let environment: string | undefined
        if (result[1] === 'begin') {
            environment = result[2].match(/{(.*?)}/)?.[1]
        }
        for (const packageName of packages) {
            if (environment) {
                const environments = this.extension.completer.environment.getPackageEnvs(EnvSnippetType.AsCommand).get(packageName) || []
                for (const env of environments) {
                    if (environment !== env.signature.name) {
                        continue
                    }
                    if (index !== env.keyvalIndex + 1) { // Start from one.
                        continue
                    }
                    candidate = env
                }
            } else {
                const commands = this.extension.completer.command.getPackageCmds(packageName)
                for (const command of commands) {
                    if (result[1] !== command.signature.name) {
                        continue
                    }
                    if (index !== command.keyvalIndex) {
                        continue
                    }
                    candidate = command
                    break
                }
            }
            if (candidate !== undefined) {
                break
            }
        }
        return candidate?.keyvals?.map(keyval => new vscode.CompletionItem(keyval, vscode.CompletionItemKind.Constant)) || []
    }

    private providePackageOptions(args: {document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext}): vscode.CompletionItem[] {
        const line = args.document.lineAt(args.position.line).text
        const regex = /\\usepackage.*?{(.*?)}/
        const match = line.match(regex)
        if (!match) {
            return []
        }
        this.extension.completer.loadPackageData(match[1])
        return this.extension.completer.package.getPackageOptions(match[1]).map(opt => new vscode.CompletionItem(opt, vscode.CompletionItemKind.Constant))
    }

    private provideClassOptions(args: {document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext}): vscode.CompletionItem[] {
        const line = args.document.lineAt(args.position.line).text
        const regex = /\\documentclass.*?{(.*?)}/
        const match = line.match(regex)
        if (!match) {
            return []
        }
        this.extension.completer.loadPackageData(`class-${match[1]}`)
        return this.extension.completer.package.getPackageOptions(`class-${match[1]}`).map(opt => new vscode.CompletionItem(opt, vscode.CompletionItemKind.Constant))
    }

    private getArgumentIndex(argstr: string) {
        let argumentIndex = 0
        let curlyLevel = argstr[0] === '{' ? 1 : 0
        let squareLevel = argstr[0] === '[' ? 1 : 0
        for (let index = 1; index < argstr.length; index++) {
            if (argstr[index-1] === '\\') {
                continue
            }
            switch (argstr[index]) {
                case '{':
                    curlyLevel++
                    break
                case '[':
                    squareLevel++
                    break
                case '}':
                    curlyLevel--
                    if (curlyLevel === 0 && squareLevel === 0) {
                        argumentIndex++
                    }
                    break
                case ']':
                    squareLevel--
                    if (curlyLevel === 0 && squareLevel === 0) {
                        argumentIndex++
                    }
                    break
                default:
                    break
            }
        }
        return argumentIndex
    }
}

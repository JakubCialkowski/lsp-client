import * as assert from 'assert'
import mock from 'mock-require'
import * as sinon from 'sinon'
import {
    Definition,
    Hover,
    InitializeParams,
    InitializeResult,
    Location,
    MarkupKind,
    ReferenceParams,
    TextDocumentPositionParams,
} from 'vscode-languageserver-protocol'
import { createMockSourcegraphAPI, stubTransport } from './stubs'

const sourcegraph = createMockSourcegraphAPI()
// For modules importing Range/Location/Position/URI/etc
mock('sourcegraph', sourcegraph)

import { register } from '..'
import { NoopLogger } from '../logging'

const logger = new NoopLogger()

describe('register()', () => {
    it('should initialize one connection with each workspace folder if the server is multi-root capable', async () => {
        const sourcegraph = createMockSourcegraphAPI()
        sourcegraph.workspace.roots = [{ uri: 'git://repo1?rev' }, { uri: 'git://repo2?rev' }]
        const server = {
            initialize: sinon.spy((params: InitializeParams): InitializeResult => ({ capabilities: {} })),
        }
        const createConnection = stubTransport(server)
        await register({
            sourcegraph: sourcegraph as any,
            transport: createConnection,
            supportsWorkspaceFolders: true,
            documentSelector: [{ language: 'foo' }],
            logger,
        })
        sinon.assert.calledOnce(createConnection)
        sinon.assert.calledOnce(server.initialize)
        sinon.assert.calledWith(
            server.initialize,
            sinon.match({
                rootUri: null,
                workspaceFolders: [{ name: '', uri: 'git://repo1?rev' }, { name: '', uri: 'git://repo2?rev' }],
            })
        )
    })
    it('should initialize one connection for each workspace folder if the server is not multi-root capable', async () => {
        const sourcegraph = createMockSourcegraphAPI()
        sourcegraph.workspace.roots = [{ uri: 'git://repo1?rev' }, { uri: 'git://repo2?rev' }]
        const server = {
            initialize: sinon.spy((params: InitializeParams): InitializeResult => ({ capabilities: {} })),
        }
        const createConnection = stubTransport(server)
        await register({
            sourcegraph: sourcegraph as any,
            transport: createConnection,
            supportsWorkspaceFolders: false,
            documentSelector: [{ language: 'foo' }],
            logger,
        })
        sinon.assert.calledTwice(createConnection)
        sinon.assert.calledTwice(server.initialize)
        sinon.assert.calledWith(
            server.initialize,
            sinon.match({
                rootUri: 'git://repo1?rev',
                workspaceFolders: null,
            })
        )
        sinon.assert.calledWith(
            server.initialize,
            sinon.match({
                rootUri: 'git://repo2?rev',
                workspaceFolders: null,
            })
        )
    })
    it('should close a connection when a workspace folder is closed', async () => {
        const sourcegraph = createMockSourcegraphAPI()
        sourcegraph.workspace.roots = [{ uri: 'git://repo1?rev' }, { uri: 'git://repo2?rev' }]
        const server = {
            initialize: sinon.spy((params: InitializeParams): InitializeResult => ({ capabilities: {} })),
        }
        const createConnection = stubTransport(server)
        await register({
            sourcegraph: sourcegraph as any,
            transport: createConnection,
            supportsWorkspaceFolders: false,
            documentSelector: [{ language: 'foo' }],
            logger,
        })
        const unsubscribed = createConnection.returnValues[0].closeEvent.toPromise()
        sourcegraph.workspace.roots.shift()
        sourcegraph.workspace.rootChanges.next()
        await unsubscribed
        sinon.assert.calledOnce(createConnection.returnValues[0].unsubscribe)
    })
    it('should register a references provider if the server reports the references capability', async () => {
        const repoRoot = 'https://sourcegraph.test/repo@rev/-/raw/'
        const server = {
            initialize: sinon.spy(
                (params: InitializeParams): InitializeResult => ({
                    capabilities: {
                        referencesProvider: true,
                    },
                })
            ),
            'textDocument/references': sinon.spy(
                (params: ReferenceParams): Location[] => [
                    {
                        uri: new URL('bar.ts', repoRoot).href,
                        range: {
                            start: { line: 1, character: 2 },
                            end: { line: 3, character: 4 },
                        },
                    },
                ]
            ),
        }
        const createConnection = stubTransport(server)

        sourcegraph.workspace.textDocuments = [
            {
                uri: new URL('foo.ts', repoRoot).href,
                languageId: 'typescript',
                text: 'console.log("Hello world")',
            },
        ]
        sourcegraph.workspace.roots = [{ uri: repoRoot }]

        const documentSelector = [{ language: 'typescript' }]
        await register({
            sourcegraph: sourcegraph as any,
            transport: createConnection,
            documentSelector,
            logger,
        })

        sinon.assert.calledWith(
            server.initialize,
            sinon.match({
                capabilities: {
                    textDocument: {
                        references: {
                            dynamicRegistration: true,
                        },
                    },
                },
            })
        )

        sinon.assert.calledOnce(sourcegraph.languages.registerReferenceProvider)

        const [selector, provider] = sourcegraph.languages.registerReferenceProvider.args[0]
        assert.deepStrictEqual(selector, [
            {
                language: 'typescript',
                pattern: 'https://sourcegraph.test/repo@rev/-/raw/**',
            },
        ])
        const result = await provider.provideReferences(
            sourcegraph.workspace.textDocuments[0],
            new sourcegraph.Position(0, 2),
            { includeDeclaration: false }
        )
        sinon.assert.calledOnce(server['textDocument/references'])
        sinon.assert.calledWith(server['textDocument/references'], {
            textDocument: { uri: sourcegraph.workspace.textDocuments[0].uri },
            position: { line: 0, character: 2 },
            context: { includeDeclaration: false },
        })
        assert.deepStrictEqual(result, [
            {
                uri: new URL('bar.ts', repoRoot),
                range: new sourcegraph.Range(new sourcegraph.Position(1, 2), new sourcegraph.Position(3, 4)),
            },
        ])
    })
    it('should register a definition provider if the server reports the definition capability', async () => {
        const repoRoot = 'https://sourcegraph.test/repo@rev/-/raw/'
        const server = {
            initialize: sinon.spy(
                (params: InitializeParams): InitializeResult => ({
                    capabilities: {
                        definitionProvider: true,
                    },
                })
            ),
            'textDocument/definition': sinon.spy(
                (params: TextDocumentPositionParams): Definition => ({
                    uri: new URL('bar.ts', repoRoot).href,
                    range: {
                        start: { line: 1, character: 2 },
                        end: { line: 3, character: 4 },
                    },
                })
            ),
        }
        const createConnection = stubTransport(server)

        sourcegraph.workspace.textDocuments = [
            {
                uri: new URL('foo.ts', repoRoot).href,
                languageId: 'typescript',
                text: 'console.log("Hello world")',
            },
        ]
        sourcegraph.workspace.roots = [{ uri: repoRoot }]

        const documentSelector = [{ language: 'typescript' }]
        await register({
            sourcegraph: sourcegraph as any,
            transport: createConnection,
            documentSelector,
            logger,
        })

        sinon.assert.calledWith(
            server.initialize,
            sinon.match({
                capabilities: {
                    textDocument: {
                        definition: {
                            dynamicRegistration: true,
                        },
                    },
                },
            })
        )

        sinon.assert.calledOnce(sourcegraph.languages.registerDefinitionProvider)

        const [selector, provider] = sourcegraph.languages.registerDefinitionProvider.args[0]
        assert.deepStrictEqual(selector, [
            {
                language: 'typescript',
                pattern: 'https://sourcegraph.test/repo@rev/-/raw/**',
            },
        ])
        const result = await provider.provideDefinition(
            sourcegraph.workspace.textDocuments[0],
            new sourcegraph.Position(0, 2)
        )
        sinon.assert.calledOnce(server['textDocument/definition'])
        sinon.assert.calledWith(server['textDocument/definition'], {
            textDocument: { uri: sourcegraph.workspace.textDocuments[0].uri },
            position: { line: 0, character: 2 },
        })
        assert.deepStrictEqual(result, [
            {
                uri: new URL('bar.ts', repoRoot),
                range: new sourcegraph.Range(new sourcegraph.Position(1, 2), new sourcegraph.Position(3, 4)),
            },
        ])
    })
    it('should register a hover provider if the server reports the hover capability', async () => {
        const repoRoot = 'https://sourcegraph.test/repo@rev/-/raw/'
        const server = {
            initialize: sinon.spy(
                async (params: InitializeParams): Promise<InitializeResult> => ({
                    capabilities: {
                        hoverProvider: true,
                    },
                })
            ),
            'textDocument/hover': sinon.spy(
                async (params: TextDocumentPositionParams): Promise<Hover> => ({
                    contents: { kind: MarkupKind.Markdown, value: 'Hello World' },
                })
            ),
        }
        const createConnection = stubTransport(server)

        sourcegraph.workspace.textDocuments = [
            {
                uri: repoRoot + '#foo.ts',
                languageId: 'typescript',
                text: 'console.log("Hello world")',
            },
        ]
        sourcegraph.workspace.roots = [{ uri: repoRoot }]

        const documentSelector = [{ language: 'typescript' }]
        await register({
            sourcegraph: sourcegraph as any,
            transport: createConnection,
            documentSelector,
            logger,
        })

        sinon.assert.calledWith(
            server.initialize,
            sinon.match({
                capabilities: {
                    textDocument: {
                        hover: {
                            contentFormat: ['markdown'],
                            dynamicRegistration: true,
                        },
                    },
                },
            })
        )

        // Assert hover provider was registered
        sinon.assert.calledOnce(sourcegraph.languages.registerHoverProvider)

        const [selector, hoverProvider] = sourcegraph.languages.registerHoverProvider.args[0]
        assert.deepStrictEqual(selector, [
            {
                language: 'typescript',
                // If the server is not multi-root capable and
                // we're in multi-connection mode, the document
                // selector should be scoped to the root URI
                // of the connection that registered the provider
                pattern: 'https://sourcegraph.test/repo@rev/-/raw/**',
            },
        ])
        const result = await hoverProvider.provideHover(
            sourcegraph.workspace.textDocuments[0],
            new sourcegraph.Position(0, 2)
        )
        sinon.assert.calledOnce(server['textDocument/hover'])
        sinon.assert.calledWith(server['textDocument/hover'], {
            textDocument: { uri: sourcegraph.workspace.textDocuments[0].uri },
            position: { line: 0, character: 2 },
        })
        assert.deepStrictEqual(result, {
            range: undefined,
            contents: { kind: MarkupKind.Markdown, value: 'Hello World' },
        })
    })
})

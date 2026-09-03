#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

const dirFlag = process.argv.indexOf('--dir')
const root = dirFlag === -1 ? '.spoor' : (process.argv[dirFlag + 1] ?? '.spoor')

const server = createServer(root)
await server.connect(new StdioServerTransport())

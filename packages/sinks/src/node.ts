/** Node-only sinks. Kept out of the main entry point so an edge adapter never
 *  pulls a Node built-in into its bundle. */
export { fileSink } from './file.js'
export type { FileSinkOptions } from './file.js'

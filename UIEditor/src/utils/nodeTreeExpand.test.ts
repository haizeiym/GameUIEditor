import assert from 'node:assert/strict'
import type { UINode } from '../types'
import { collectNodeIds, pruneExpandedKeys } from './nodeTreeExpand'

function node(id: string, children: UINode[] = []): UINode {
  return {
    _id: id,
    name: id,
    active: true,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    zIndex: 0,
    components: {},
    children,
  }
}

const tree = node('root', [node('a', [node('a1')]), node('b')])

assert.deepEqual(collectNodeIds(tree), ['root', 'a', 'a1', 'b'])
assert.deepEqual(pruneExpandedKeys(['root', 'gone', 'a', 'a', 'b'], tree), ['root', 'a', 'b'])
assert.deepEqual(pruneExpandedKeys(['x', 'y'], tree), [])

console.log('nodeTreeExpand.test.ts: ok')

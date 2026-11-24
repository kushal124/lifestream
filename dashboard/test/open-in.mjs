// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { holdProducts } from '../public/lib/kinds.js';
import { handleFrom, handleIcon, handleValue, handleWords, networkWords } from '../public/ui/people/words.js';

const declared = {
  'example-chat': { name: 'Example Chat', row: 'Example Chat', vendor: 'example', icon: 'message', type: 'messages', connector: 'example-chat' },
  'example-log': { name: 'Example Log', row: 'Example Log', vendor: 'example', icon: 'recording', type: 'notes', connector: 'example-log' },
};

test('O6: a handle is drawn from the home\'s words; a network\'s name and icon from the products read', () => {
  holdProducts(declared);
  /** @type {import('../public/ui/people/words.js').Handle[]} */
  const [phone, network, hidden] = [
    { id: 'phone:+15550000001', kind: 'phone', network: null, words: '+1 555 000 0001', from: 'Contacts' },
    { id: 'example-chat:12345', kind: 'network', network: 'example-chat', words: 'Person A', from: null },
    { id: 'jid:15550000001@lid', kind: 'jid', network: null, words: 'Hidden number', from: null },
  ];
  assert.deepEqual([handleWords(phone), handleFrom(phone), handleIcon(phone), handleValue(phone)], ['+1 555 000 0001', 'Contacts', 'call', '+15550000001']);
  assert.deepEqual([handleWords(network), handleFrom(network), handleIcon(network), handleValue(network)],
    ['Person A', 'Example Chat', 'message', 'example-chat:12345'], 'a network\'s handle is its id whole, named by its product');
  assert.deepEqual([handleWords(hidden), handleFrom(hidden), handleIcon(hidden)], ['Hidden number', 'In your messages', 'message']);
  assert.equal(networkWords('example-chat'), 'Example Chat');
  assert.equal(networkWords('example-gone'), 'example-gone', 'a product the read lacks by its id as written');
});

import { readOuterParams } from './outer-gallery-params';
import { sampleFriends } from './outer-gallery-fixtures';

describe('what the outer gallery reads from its address', () => {
  it('shows fourteen friends at rest, with buttons, by default', () => {
    expect(readOuterParams({})).toEqual({
      friends: 14,
      panX: 0,
      panY: 0,
      status: 'ready',
      buttons: true,
      list: false,
      web: true,
    });
  });

  it('reads every choice', () => {
    expect(
      readOuterParams({
        friends: '40',
        panx: '-120',
        pany: '60.5',
        status: 'offline',
        buttons: '0',
        list: '1',
        web: '0',
      }),
    ).toEqual({ friends: 40, panX: -120, panY: 60.5, status: 'offline', buttons: false, list: true, web: false });
  });

  it('holds friends to 0..200 and falls back on anything it cannot read', () => {
    expect(readOuterParams({ friends: '999' }).friends).toBe(200);
    expect(readOuterParams({ friends: '-3' }).friends).toBe(0);
    expect(readOuterParams({ friends: 'many', panx: 'left', status: 'sad' })).toMatchObject({
      friends: 14,
      panX: 0,
      status: 'ready',
    });
  });
});

describe('the sample friends', () => {
  it('are unique, in a stable order, and start with the prototype’s two', () => {
    const friends = sampleFriends(60);
    expect(new Set(friends.map((friend) => friend.handle)).size).toBe(60);
    expect(new Set(friends.map((friend) => friend.personId)).size).toBe(60);
    expect(friends.slice(0, 2).map((friend) => friend.name)).toEqual(['Ravi', 'Mei']);
    expect(sampleFriends(0)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  canUseZhulangCodec,
  mapZhulangDetailPayload,
  mapZhulangSearchPayload,
  mapZhulangTocPayload,
  zhulangSearchPath,
} from '../src/legado/zhulangSource.js';

describe('audited Zhulang source adapter', () => {
  it('requires the exact source identity and jsLib fingerprint', () => {
    expect(canUseZhulangCodec({
      bookSourceName: '连尚读书[官方]',
      bookSourceUrl: 'https://read.zhulang.com',
      jsLib: 'not trusted',
    })).toBe(false);
  });

  it('builds the search URL without evaluating the uploaded @js rule', () => {
    expect(zhulangSearchPath('重生', 2)).toBe(
      '/v3/search/list?word=%E9%87%8D%E7%94%9F&search_type=2&related_type=0&offset=20&limit=20',
    );
  });

  it('maps encrypted API payload shapes into safe runtime values', () => {
    const search = mapZhulangSearchPayload({
      data: { list: [{ book_detail: {
        book_id: 42,
        title: '测试书',
        author_name: '作者',
        tags: [{ tag_name: '玄幻' }],
        finish: 1,
        chapter_name: '终章',
        intro: '简介',
        cover: 'https://readstatic.zhulang.com/42.jpg',
      } }] },
    });
    expect(search[0]).toMatchObject({
      title: '测试书',
      kind: ['玄幻', '已完结'],
      bookUrl: 'https://read.zhulang.com/v3/book/detail/42',
    });

    expect(mapZhulangDetailPayload({ data: {
      id: 42,
      name: '测试书',
      author_name: '作者',
      jin_cate1_name: '玄幻',
      word_count_cn: '10万字',
      last_update_chapter: { name: '终章' },
      description: '简介',
      copyright: '版权',
      cover: 'https://readstatic.zhulang.com/42.jpg',
    } })).toMatchObject({
      title: '测试书',
      tocUrl: 'https://read.zhulang.com/v3/book/chapters/42?page=0&limit=1000000',
    });

    expect(mapZhulangTocPayload({ data: {
      titles: ['chapter_id', 'name', 'seq_id'],
      items: [['100', '第一章', '1']],
    } }, 42)).toEqual([{
      title: '第一章',
      order: 0,
      url: 'https://read.zhulang.com/v3/book/read?book_id=42&chapter_id=100&seq_id=1',
    }]);
  });
});

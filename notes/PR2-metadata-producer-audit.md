# PR2 元数据生产者审计

审计范围：`src/ts/`，忽略 `src/static/`。包含直接调用和动态选择
`API.getArtworkData` / `API.getNovelData` 的调用，以及 `getWorkDataAsync` 调用。
API.ts 中的方法定义、CacheWorkData.ts 中的重载签名不是调用点。

| 调用模块与入口 | 分类 | 处理 |
| --- | --- | --- |
| `crawl/InitPageBase.ts`: `getWorksData` 的小说缓存读取和图像 API 请求 | already main-path coordinated | 保留 PR1：未缓存小说和图像请求申请父代数会话许可 |
| `download/MergeNovel.ts`: `fetchNovelData` | coordinated bulk/crawl | 未缓存小说仅申请一次许可；嵌套合并复用父会话，系列展开后可提升数量；独立合并在已知数量后登记，finally 关闭 |
| `crawl/VipSearchOptimize.ts`: `checkWork` 的小说、图像请求 | coordinated bulk/crawl | 搜索页面经基类保护方法传入本代会话许可，累积数量提升原会话；禁用优化不申请许可 |
| `pageFunciton/BookmarkAllWorks.ts`: `getTagData` 的小说、图像请求 | coordinated bulk/crawl | 整个标签批次使用一个会话，finally 关闭；禁用标签时不创建会话 |
| `filter/WorkPublishTime.ts`: `crawlWork` 动态 API 请求 | coordinated bulk/crawl | PPDTask 11 的维护抓取循环，每个类型的批次使用一个会话；顺延 ID 的重试仍需许可，finally 关闭 |
| `store/CacheWorkData.ts`: `getWorkDataAsync` 递归等待及动态 API 请求 | cache internals | 调用方负责批量许可；缓存本身也服务交互功能，不全局限速 |
| `Bookmark.ts`: `getWorkData` 的图像、小说请求 | deliberately excluded one-off interactive UI | 普通单篇收藏；BookmarkAllWorks 已提供 tags，其收藏阶段不触发这里的元数据请求 |
| `CopyWorkInfo.ts`: `receive` 动态 API 请求 | deliberately excluded one-off interactive UI | 用户复制单个作品信息 |
| `ImageViewer.ts`: 缓存读取、非公开作品图像 API 请求 | deliberately excluded one-off interactive UI | 查看当前作品 |
| `PreviewWork.ts`: `getWorkDataAsync` | deliberately excluded one-off interactive UI | 用户预览单个作品 |
| `PreviewWorkDetailInfo.ts`: `getWorkDataAsync` | deliberately excluded one-off interactive UI | 当前预览作品的详情 |
| `ShowOriginSizeImage.ts`: 两处 `getWorkDataAsync` | deliberately excluded one-off interactive UI | 当前作品或用户选定作品的原图查看 |
| `buttonsOnThumb/ButtonsOnArtworkPage.ts`: `getWorkDataAsync` | deliberately excluded one-off interactive UI | 当前作品按钮 |
| `pageFunciton/QuickBookmark.ts`: `getWorkDataAsync`、动态 API 请求 | deliberately excluded one-off interactive UI | 当前作品的快速收藏 |
| `pageFunciton/DisplayThumbnailListOnMultiImageWorkPage.ts`: `getWorkDataAsync` | deliberately excluded one-off interactive UI | 当前多图作品的缩略图列表 |

`AutoMergeNovel` 和 `InitNovelSeriesPage` 的手动合并按钮没有直接请求作品元数据，
都进入上述 MergeNovel 路径。列表、设定资料、图片/封面下载、导出及文件下载不申请元数据许可。
所有旧的 slowCrawl / slowCrawlDealy / crawlInterval 延迟保留。

`tests/crawl-rate-producers.test.cjs` 的源码审计使用 TypeScript AST 检查以上清单。
新增显式调用或动态方法名会要求更新分类；运行时测试另验证许可、代数取消、会话生命周期和阈值。
动态 API 条件表达式的两个方法名在源码审计中计作两个引用，仍只有一个实际请求点。

# 第三方组件说明 / Third-Party Notices

书信簿（st-epistolary）本身的代码以 MIT 许可证发布，见根目录 `LICENSE`。
插件里附带或运行时加载的第三方资源，各自遵循自己的许可证，不受 MIT 许可证约束：

## 随插件附带的字体（`fonts/`）

均为 SIL Open Font License 1.1（OFL-1.1），文件取自 Fontsource 打包的 Google Fonts 版本（只含拉丁 / 拉丁扩展字符）。授权全文在 `fonts/LICENSE-*.txt`。

| 字体 | 作者 / 版权 | 许可证 | 授权文件 |
|---|---|---|---|
| EB Garamond | Copyright 2017 The EB Garamond Project Authors | OFL-1.1 | `fonts/LICENSE-eb-garamond.txt` |
| Allura | Copyright 2010 The Allura Project Authors | OFL-1.1 | `fonts/LICENSE-allura.txt` |
| Great Vibes | Copyright 2010 The Great Vibes Pro Project Authors | OFL-1.1 | `fonts/LICENSE-great-vibes.txt` |
| Caveat | Copyright 2014 The Caveat Project Authors | OFL-1.1 | `fonts/LICENSE-caveat.txt` |

## 运行时从 jsDelivr 按需加载的中文字体（不随插件附带）

| 字体 | 来源 | 许可证 |
|---|---|---|
| 霞鹜文楷 LXGW WenKai | `lxgw-wenkai-webfont` | OFL-1.1 |
| 思源宋体 Noto Serif SC | `@fontsource/noto-serif-sc` | OFL-1.1 |
| 马善政楷书 Ma Shan Zheng | `@fontsource/ma-shan-zheng` | OFL-1.1 |

设置里关掉「在线加载中文书信字体」就不会加载这些字体。

## 代码

书信簿没有复制其他项目的代码。设计上参考过一些 SillyTavern 扩展的思路（只参考做法，未使用其代码）。
本插件运行在 SillyTavern（AGPL-3.0）里，通过 SillyTavern 提供的扩展接口工作，不包含 SillyTavern 的代码。

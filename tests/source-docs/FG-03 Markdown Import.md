# FG-03 Markdown Import

This document verifies Feishu Markdown import and subsequent local export.

## Text structure

Paragraph alpha contains **bold text**, *italic text*, `inline code`, and a [public link](https://example.com/fixture).

> Quote sentinel: QUOTE-9B21

- Bullet item alpha
- Bullet item beta
  - Nested bullet gamma

1. Ordered item one
2. Ordered item two

## Table structure

| Identifier | Description | Quantity |
| --- | --- | ---: |
| ROW-A1 | Alpha | 1 |
| ROW-B2 | Beta | 20 |
| ROW-C3 | Unicode 测试 | 300 |

## Code structure

```javascript
export function fixtureSum(a, b) {
  return a + b;
}
```

Final sentinel: MARKDOWN-END-42C7

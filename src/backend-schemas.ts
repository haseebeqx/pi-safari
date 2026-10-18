// Verified by initialize + tools/list only, local Safari MCP 1.0.0. No browser actions.
// Conservative exact schema matching: incompatible optional capabilities fail closed.
export const BACKEND_SCHEMAS = {
  "browser_dialogs": {
    "properties": {
      "action": { "enum": ["list", "respond", "dismiss"], "type": "string" },
      "inputText": { "type": "string" }
    },
    "required": ["action"],
    "type": "object"
  },
  "browser_console_messages": {
    "properties": {
      "clear": {
        "type": "boolean"
      },
      "level_filter": {
        "items": {
          "enum": [
            "debug",
            "info",
            "warn",
            "error"
          ],
          "type": "string"
        },
        "type": "array"
      },
      "limit": {
        "type": "integer"
      },
      "tab_handle": {
        "type": "string"
      }
    },
    "type": "object"
  },
  "get_page_content": {
    "properties": {
      "format": {
        "enum": [
          "markdown",
          "text",
          "textTree",
          "json",
          "html",
          "plainText"
        ],
        "type": "string"
      },
      "includeAccessibilityAttributes": {
        "type": "boolean"
      },
      "includeEventListeners": {
        "type": "boolean"
      },
      "includeRects": {
        "type": "boolean"
      },
      "includeSelectOptions": {
        "type": "boolean"
      },
      "includeSubframes": {
        "type": "boolean"
      },
      "includeURLs": {
        "type": "boolean"
      },
      "maxWordsPerParagraph": {
        "type": "integer"
      },
      "nodeIds": {
        "enum": [
          "none",
          "editable",
          "interactive",
          "allContainers"
        ],
        "type": "string"
      },
      "region": {
        "enum": [
          "entire_page",
          "viewport"
        ],
        "type": "string"
      },
      "savePath": {
        "type": "string"
      },
      "shortenURLs": {
        "type": "boolean"
      }
    },
    "type": "object"
  },
  "list_network_requests": {
    "properties": {
      "clear": {
        "type": "boolean"
      },
      "filter": {
        "properties": {
          "method": {
            "type": "string"
          },
          "status_max": {
            "type": "integer"
          },
          "status_min": {
            "type": "integer"
          },
          "url_substring": {
            "type": "string"
          }
        },
        "type": "object"
      },
      "since": {
        "type": "string"
      },
      "tab_handle": {
        "type": "string"
      }
    },
    "type": "object"
  },
  "navigate_to_url": {
    "properties": {
      "tab_uuid": {
        "type": "string"
      },
      "url": {
        "type": "string"
      }
    },
    "required": [
      "url"
    ],
    "type": "object"
  },
  "page_interactions": {
    "properties": {
      "fullText": {
        "type": "boolean"
      },
      "interactions": {
        "items": {
          "properties": {
            "node": {
              "type": "string"
            },
            "point": {
              "properties": {
                "x": {
                  "type": "number"
                },
                "y": {
                  "type": "number"
                }
              },
              "type": "object"
            },
            "pressReturn": {
              "type": "boolean"
            },
            "purpose": {
              "type": "string"
            },
            "replaceAll": {
              "type": "boolean"
            },
            "scrollDelta": {
              "properties": {
                "x": {
                  "type": "number"
                },
                "y": {
                  "type": "number"
                }
              },
              "type": "object"
            },
            "scrollToVisible": {
              "type": "boolean"
            },
            "text": {
              "type": "string"
            },
            "type": {
              "enum": [
                "click",
                "type",
                "keyPress",
                "scroll",
                "selectText",
                "selectMenuItem",
                "hover",
                "highlightText"
              ],
              "type": "string"
            },
            "value": {
              "type": "string"
            }
          },
          "required": [
            "purpose",
            "type"
          ],
          "type": "object"
        },
        "type": "array"
      }
    },
    "required": [
      "interactions"
    ],
    "type": "object"
  },
  "screenshot": {
    "properties": {
      "full_page": {
        "type": "boolean"
      },
      "node": {
        "type": "string"
      },
      "savePath": {
        "type": "string"
      }
    },
    "type": "object"
  },
  "set_emulated_media": {
    "properties": {
      "media": {
        "description": "CSS media type to emulate, e.g. \"screen\" or \"print\". Empty string clears the override.",
        "type": "string"
      }
    },
    "required": [
      "media"
    ],
    "type": "object"
  }
} as const;

export function schemaKey(value: unknown): string {
  const clean = (v: any): any => Array.isArray(v) ? v.map(clean) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).filter(k => k !== 'description').sort().map(k => [k, clean(v[k])])) : v;
  return JSON.stringify(clean(value));
}

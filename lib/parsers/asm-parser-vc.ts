// Copyright (c) 2018, Microsoft Corporation
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import {ParsedAsmResult, ParsedAsmResultLine} from '../../types/asmresult/asmresult.interfaces.js';
import {ParseFiltersAndOutputOptions} from '../../types/features/filters.interfaces.js';
import {assert} from '../assert.js';
import {logger} from '../logger.js';
import {PropertyGetter} from '../properties.interfaces.js';
import * as utils from '../utils.js';

import {AsmParser} from './asm-parser.js';
import {AsmRegex} from './asmregex.js';

type Source = {file: string | null; line: number | null};
type Line = {text: string; source: Source | null};
type Label = {
    lines: Line[];
    name: string | undefined;
    initialLine: number | undefined;
    file: string | null | undefined;
};

type ResultObject = {
    prefix: Line[];
    functions: Label[];
    postfix: Line | null;
};

export class VcAsmParser extends AsmParser {
    private readonly asmBinaryParser: AsmParser;
    private readonly filenameComment = /^; File (.+)/;
    protected miscDirective = /^\s*(include|INCLUDELIB|TITLE|\.|THUMB|ARM64|TTL|END$)/;
    private readonly localLabelDef = /^([$A-Z_a-z]+) =/;
    private readonly lineNumberComment = /^; Line (\d+)/;
    protected beginSegment =
        /^(CONST|_BSS|\.?[prx]?data(\$[A-Za-z]+)?|CRT(\$[A-Za-z]+)?|_TEXT|\.?text(\$[A-Za-z]+)?)\s+SEGMENT|\s*AREA/;
    protected endSegment = /^(CONST|_BSS|[prx]?data(\$[A-Za-z]+)?|CRT(\$[A-Za-z]+)?|_TEXT|text(\$[A-Za-z]+)?)\s+ENDS/;
    protected beginFunction = /^; Function compile flags: /;
    private readonly endProc = /^([$?@A-Z_a-z][\w$<>?@]*)?\s+ENDP/;
    private readonly labelFind = /[$?@A-Z_a-z][\w$<>?@]*/g;
    protected isMsvc6 = false;

    constructor(compilerProps?: PropertyGetter) {
        super(compilerProps);
        this.asmBinaryParser = new AsmParser(compilerProps);
        this.commentOnly = /^;/;

        this.labelDef = /^\|?([$?@A-Z_a-z][\w$<>?@]*)\|?\s+(PROC|=|D[BDQW])/;
        this.definesGlobal = /^\s*(PUBLIC|EXTRN|EXPORT)\s+/;
        this.definesFunction = /^\|?([$?@A-Z_a-z][\w$<>?@]*)\|?\s+PROC/;
        this.dataDefn = /^(\|?[$?@A-Z_a-z][\w$<>?@]*\|?)\sDC?[BDQW]\s|\s+DC?[BDQW]\s|\s+ORG/;

        // these are set to an impossible regex, because VC doesn't have inline assembly
        this.startAppBlock = this.startAsmNesting = /a^/;
        this.endAppBlock = this.endAsmNesting = /a^/;
        // same, but for CUDA
        this.cudaBeginDef = /a^/;
    }

    override hasOpcode(line: string): boolean {
        // note: cl doesn't output leading labels
        // strip comments
        line = line.split(';', 1)[0];
        // check for empty lines
        if (line.length === 0) return false;
        // check for a local label definition
        if (this.localLabelDef.test(line)) return false;
        // check for global label definitions
        if (this.definesGlobal.test(line)) return false;
        // check for data definitions
        if (this.dataDefn.test(line)) return false;
        // check for segment begin and end
        if (this.beginSegment.test(line) || this.endSegment.test(line)) return false;
        // check for function begin and end
        // note: functionBegin is used for the function compile flags comment
        if (this.definesFunction.test(line) || this.endProc.test(line)) return false;
        // check for miscellaneous directives
        if (this.miscDirective.test(line)) return false;

        return this.hasOpcodeRe.test(line);
    }

    override labelFindFor() {
        return this.labelFind;
    }

    override processAsm(asm: string, filters: ParseFiltersAndOutputOptions): ParsedAsmResult {
        if (filters.binary || filters.binaryObject) {
            return this.asmBinaryParser.processAsm(asm, filters);
        }

        const getFilenameFromComment = (line: string): string | null => {
            const matches = line.match(this.filenameComment);
            if (matches) {
                return matches[1];
            } else {
                return null;
            }
        };
        const getLineNumberFromComment = (line: string) => {
            const matches = line.match(this.lineNumberComment);
            if (matches) {
                return parseInt(matches[1]);
            } else {
                return null;
            }
        };

        const asmLines = utils.splitLines(asm);
        // note: VC doesn't output unused labels, afaict

        const stdInLooking = /<stdin>|^-$|example\.[^/]+$|<source>/;

        const resultObject: ResultObject = {
            prefix: [],
            functions: [],
            postfix: null,
        };

        let currentFunction: Label | null = null;
        let currentFile: string | null = null;
        let currentLine: number | null = null;

        let seenEnd = false;

        const datadefLabels: string[] = [];
        const datadefLabelsUsed: string[] = [];

        const createSourceFor = (
            hasopc: boolean,
            currentFile: string | null,
            currentLine: number | null,
        ): Source | null => {
            if (hasopc && (currentFile || currentLine)) {
                return {
                    file: currentFile || null,
                    line: currentLine || null,
                };
            }

            return null;
        };

        const checkUsedDatadefLabels = (line: string) => {
            const labels = line.match(this.labelFind);
            if (!labels) return;
            labels.splice(0, 1);
            for (const item of labels) {
                if (datadefLabels.find(l => item === l)) {
                    datadefLabelsUsed.push(item);
                }
            }
        };

        const checkBeginFunction = (line: string) => {
            if (this.beginFunction.test(line)) {
                currentFunction = {
                    lines: [],
                    initialLine: undefined,
                    name: undefined,
                    file: undefined,
                };
                resultObject.functions.push(currentFunction);
            }
            return currentFunction;
        };

        const checkForDdefLabel = (line: string) => {
            const ddef = line.match(this.dataDefn);
            if (ddef && ddef[1]) {
                datadefLabels.push(ddef[1]);
            }
        };

        if (this.isMsvc6) {
            currentFunction = {
                lines: [],
                initialLine: undefined,
                name: undefined,
                file: undefined,
            };
        }

        for (let line of asmLines) {
            if (line.trim() === 'END') {
                seenEnd = true;
                if (!filters.directives) {
                    resultObject.postfix = {text: line, source: null};
                }
                continue;
            }
            if (line.trim() === '') {
                if (seenEnd) continue;

                const emptyLine = {text: '', source: null};
                if (currentFunction === null) {
                    resultObject.prefix.push(emptyLine);
                } else {
                    currentFunction.lines.push(emptyLine);
                }
                continue;
            }
            if (seenEnd) {
                // this should never happen
                throw new Error('Visual C++: text after the end statement');
            }

            const fileName = getFilenameFromComment(line);
            if (fileName === null) {
                const lineNum = getLineNumberFromComment(line);
                if (lineNum !== null) {
                    if (currentFile === undefined) {
                        logger.error('Somehow, we have a line number comment without a file comment: %s', line);
                    }
                    assert(currentFunction);
                    if (currentFunction.initialLine === undefined) {
                        currentFunction.initialLine = lineNum;
                    }
                    currentLine = lineNum;
                }
            } else {
                if (currentFunction === null) {
                    logger.error('We have a file comment outside of a function: %s', line);
                }
                // if the file is the "main file", give it the file `null`
                if (this.isMsvc6 === false) {
                    if (stdInLooking.test(fileName)) {
                        currentFile = null;
                    } else {
                        currentFile = fileName;
                    }
                } else {
                    currentFile = fileName;
                }

                assert(currentFunction);
                if (this.isMsvc6 === false) {
                    if (currentFunction.file === undefined) {
                        currentFunction.file = currentFile;
                    }
                } else {
                    currentFunction.file = currentFile;
                }
            }

            if (!this.isMsvc6) {
                currentFunction = checkBeginFunction(line);
            }

            const functionName = line.match(this.definesFunction);
            if (functionName) {
                if (asmLines.length === 0) {
                    continue;
                }
                assert(currentFunction);
                currentFunction.name = functionName[1];
            }

            if (filters.commentOnly && this.commentOnly.test(line)) continue;

            const shouldSkip =
                filters.directives &&
                (line.match(this.endSegment) ||
                    line.match(this.definesGlobal) ||
                    line.match(this.miscDirective) ||
                    line.match(this.beginSegment));

            if (shouldSkip) {
                continue;
            }

            checkForDdefLabel(line);

            line = utils.expandTabs(line);
            const hasopc = this.hasOpcode(line);
            const textAndSource: Line = {
                text: AsmRegex.filterAsmLine(line, filters),
                source: createSourceFor(hasopc, currentFile, currentLine),
            };
            if (currentFunction === null) {
                resultObject.prefix.push(textAndSource);
            } else if (!shouldSkip) {
                currentFunction.lines.push(textAndSource);
            }

            checkUsedDatadefLabels(line);

            if (this.isMsvc6 && this.endProc.test(line)) {
                assert(currentFunction);
                resultObject.functions.push(currentFunction);
                currentFunction = {
                    lines: [],
                    initialLine: undefined,
                    name: undefined,
                    file: undefined,
                };
                currentFunction.file = currentFile;
            }
        }

        return this.resultObjectIntoArray(resultObject, filters, datadefLabelsUsed);
    }

    resultObjectIntoArray(
        obj: ResultObject,
        filters: ParseFiltersAndOutputOptions,
        ddefLabelsUsed: string[],
    ): ParsedAsmResult {
        const collator = new Intl.Collator();

        obj.functions.sort((f1, f2) => {
            // order the main file above all others
            if (f1.file === null && f2.file !== null) {
                return -1;
            }
            if (f1.file !== null && f2.file === null) {
                return 1;
            }
            // order no-file below all others
            if (f1.file === undefined && f2.file !== undefined) {
                return 1;
            }
            if (f1.file !== undefined && f2.file === undefined) {
                return -1;
            }

            // if the files are the same, use line number ordering
            if (f1.file === f2.file) {
                // if the lines are the same as well, it's either:
                //   - two template instantiations, or
                //   - two compiler generated functions
                // order by name
                if (f1.initialLine === f2.initialLine) {
                    return collator.compare(f1.name || '', f2.name || '');
                } else {
                    // NOTE: initialLine can be undefined here, that's ok
                    return (f1.initialLine as number) - (f2.initialLine as number);
                }
            }

            // else, order by file
            assert(typeof f1.file === 'string' && typeof f2.file === 'string');
            return collator.compare(f1.file, f2.file);
        });

        const result: ParsedAsmResultLine[] = [];
        let lastLineWasWhitespace = true;
        const pushLine = (line: ParsedAsmResultLine) => {
            if (line.text.trim() === '') {
                if (!lastLineWasWhitespace) {
                    result.push({text: '', source: null});
                    lastLineWasWhitespace = true;
                }
            } else {
                result.push(line);
                lastLineWasWhitespace = false;
            }
        };

        if (filters.labels) {
            let currentDdef: string | undefined;
            let isUsed = false;
            for (const line of obj.prefix) {
                const matches = line.text.match(this.dataDefn);
                if (matches) {
                    if (matches[1]) {
                        currentDdef = matches[1];
                        isUsed = !!ddefLabelsUsed.find(label => currentDdef === label);
                    }

                    if (isUsed) {
                        pushLine(line);
                    }
                } else {
                    currentDdef = undefined;
                    pushLine(line);
                }
            }
        } else {
            for (const line of obj.prefix) {
                pushLine(line);
            }
        }

        for (const func of obj.functions) {
            let include = true;
            if (this.isMsvc6) {
                if (filters.libraryCode && func.file?.includes('VC98\\include\\')) {
                    include = false;
                }
            } else if (!filters.libraryCode || func.file === null) {
                include = true;
            }
            if (include) {
                pushLine({text: '', source: null});
                for (const line of func.lines) {
                    pushLine(line);
                }
            }
        }

        if (obj.postfix !== null) {
            pushLine(obj.postfix);
        }

        return {
            asm: result,
        };
    }
}

import "@logseq/libs";

const addHours = (date: Date, hours: number) => {
    const copy = new Date(date);
    copy.setHours(date.getHours() + hours);
    return copy;
};

const addDays = (date: Date, days: number) => {
    const copy = new Date(date);
    copy.setDate(date.getDate() + days);
    return copy;
};

const addWeeks = (date: Date, weeks: number) => {
    const copy = new Date(date);
    copy.setDate(date.getDate() + weeks * 7);
    return copy;
};

const addMonths = (date: Date, months: number) => {
    const copy = new Date(date);
    copy.setMonth(date.getMonth() + months);
    return copy;
};

const addYears = (date: Date, years: number) => {
    const copy = new Date(date);
    copy.setFullYear(date.getFullYear() + years);
    return copy;
};
const DATE_TO_WEEK_PREFIX = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const intervalTypeToFunction = {
    h: addHours,
    d: addDays,
    w: addWeeks,
    m: addMonths,
    y: addYears,
};

const parseOrgDate = (date: string) => {
    date = date.trim(); // either 2021-09-09 Thu or 2021-09-09 Thu 10:00
    const retDate = new Date();
    retDate.setSeconds(0);
    let hasTime = false;
    if (date.length === 14) {
        hasTime = false;
        retDate.setHours(0);
        retDate.setMinutes(0);
    } else if (date.length === 20) {
        retDate.setHours(parseInt(date.slice(15, 17)));
        retDate.setMinutes(parseInt(date.slice(18, 20)));
        hasTime = true;
    } else throw new Error("invalid date format");

    retDate.setFullYear(parseInt(date.slice(0, 4)));
    retDate.setMonth(parseInt(date.slice(5, 7)) - 1);
    retDate.setDate(parseInt(date.slice(8, 10)));

    if (isNaN(retDate.getTime())) throw new Error("invalid date format");
    return {
        date: retDate,
        hasTime,
    };
};

const stringifyOrgDate = ({ date, hasTime }: { date: Date; hasTime: boolean }) => {
    if (date.getHours() !== 0 || date.getMinutes() !== 0) hasTime = true;

    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();

    const weekDay = DATE_TO_WEEK_PREFIX[date.getDay()];

    const noTime = `${year}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")} ${weekDay}`;

    if (!hasTime) return noTime;

    const hour = date.getHours();
    const minute = date.getMinutes();

    return `${noTime} ${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
};

const LOGBOOK_END = "\n:END:";
const LOGBOOK_START = "\n:LOGBOOK:\n";
const STATE_CHANGE_REGEX = /\* State "DONE" from "\w+" \[(\d\d\d\d-\d\d-\d\d \w\w\w \d\d:\d\d)\]/;
const STATE_CHANGE_DATE_TIME_MARGIN = 90 * 1000; // 90 seconds
const SCHEDULED_REGEX = /\nSCHEDULED: <(\d\d\d\d-\d\d-\d\d \w\w\w(?: \d\d:\d\d)?)( [\.\+]{1,2}\d+\w)?>/;
const INTERVAL_REGEX = /([\.\+]{1,2})(\d+)(\w)/;
const ORG_MODE_REPEAT_FROM_COMPLETION_DATE = ".+";
const ORG_MODE_REPEAT_FROM_FUTURE_CYCLE_DATE = "++";
const MAX_ITERATIONS = 1000;

const getStateChangeDate = (content: string) => {
    const match = content.match(STATE_CHANGE_REGEX);
    if (!match) return null;
    return parseOrgDate(match[1]);
};

const getScheduledDateInterval = (content: string) => {
    const matches = content.match(new RegExp(SCHEDULED_REGEX, "g"));
    if (!matches || matches.length !== 1) return null;

    const scheduledMatch = matches[0].match(SCHEDULED_REGEX);
    if (!scheduledMatch) {
        console.error("no scheduled date detected");
        return null;
    }
    const scheduledDate = parseOrgDate(scheduledMatch[1]);
    const scheduledInterval = scheduledMatch[2]?.slice(1);
    if (!scheduledInterval) {
        console.error("no interval detected");
        return null;
    }

    return {
        scheduledDate,
        scheduledInterval,
    };
};

const clearTime = (date: Date) => {
    date.setHours(0);
    date.setMinutes(0);
    date.setSeconds(0);
    return date;
};

const parseInterval = (interval: string) => {
    const match = interval.match(INTERVAL_REGEX);
    if (!match) throw new Error("invalid interval");
    const [_, mode, amount, type] = match;
    return { mode, amount, type };
};

const applyInterval = (date: Date, interval: string) => {
    const { mode, amount, type } = parseInterval(interval);
    const func = intervalTypeToFunction[type];
    if (!func) throw new Error("invalid interval type");
    const newDate: Date = func(date, parseInt(amount));
    return newDate;
};

const getLogbook = (content: string) => {
    const hasLogbook = content.endsWith(LOGBOOK_END) && content.includes(LOGBOOK_START);
    if (!hasLogbook) return null;

    const logbook = content.slice(content.lastIndexOf(LOGBOOK_START) + LOGBOOK_START.length, -LOGBOOK_END.length).split("\n");
    if (!logbook.length) return null;
    return logbook;
};

async function main() {
    logseq.DB.onChanged((changes) => {
        try {
            changes.blocks.forEach((block) => {
                if (block["repeated?"] !== true) return;
                if (typeof block.scheduled !== "number") return;
                if (block.format !== "markdown") return; // idk how org mode is different
                const currentContent = block.content;
                if (typeof currentContent !== "string") return;

                const contentStatements = changes.txData.filter((v) => v[1] === "content").filter((v) => v[0] === block.id);
                if (contentStatements.length !== 2) return;
                if (contentStatements[0][4] !== false || contentStatements[1][4] !== true) return;
                if (contentStatements[1][2] !== currentContent) return;
                if (contentStatements[0][2] === currentContent) return;
                if (contentStatements[0][3] !== contentStatements[1][3]) return;
                const oldContent = contentStatements[0][2];
                if (typeof oldContent !== "string") return;

                const oldScheduledDateInterval = getScheduledDateInterval(oldContent);
                if (!oldScheduledDateInterval) return;

                const currentScheduledDateInterval = getScheduledDateInterval(currentContent);
                if (!currentScheduledDateInterval) return;

                const { scheduledDate, scheduledInterval } = currentScheduledDateInterval;

                if (scheduledInterval !== oldScheduledDateInterval.scheduledInterval) {
                    if (parseInterval(scheduledInterval).mode !== parseInterval(oldScheduledDateInterval.scheduledInterval).mode) {
                        logseq.UI.showMsg("Repeating task interval mode changed"); // friendly warning since logseq changes the interval mode automatically when the scheduler is used to update
                    }
                    return;
                }
                const { mode: intervalMode } = parseInterval(scheduledInterval);

                const oldLogbook = getLogbook(oldContent);
                if (!oldLogbook) return;

                const currentLogbook = getLogbook(currentContent);
                if (!currentLogbook) return;

                if (currentLogbook.length <= oldLogbook.length) return; // no new logbook entries or logbook entries were deleted (maybe because of an undo)

                const lastCurrentLogbookEntry = currentLogbook[currentLogbook.length - 1];
                const lastCurrentLogbookEntryDate = getStateChangeDate(lastCurrentLogbookEntry);
                if (!lastCurrentLogbookEntryDate) return; // last logbook entry is not a state change

                if (Date.now() - lastCurrentLogbookEntryDate.date.getTime() > STATE_CHANGE_DATE_TIME_MARGIN) return; // last logbook entry is too old

                const newScheduledDate = (() => {
                    if (intervalMode === ORG_MODE_REPEAT_FROM_COMPLETION_DATE) {
                        const baseDate = scheduledDate.hasTime ? lastCurrentLogbookEntryDate.date : clearTime(lastCurrentLogbookEntryDate.date);

                        return { date: applyInterval(baseDate, scheduledInterval), hasTime: scheduledDate.hasTime };
                    }
                    if (intervalMode === ORG_MODE_REPEAT_FROM_FUTURE_CYCLE_DATE) {
                        let nextScheduledDate = scheduledDate.date;
                        let count = 0;
                        while (nextScheduledDate.getTime() < lastCurrentLogbookEntryDate.date.getTime() && count++ < MAX_ITERATIONS) {
                            nextScheduledDate = applyInterval(nextScheduledDate, scheduledInterval);
                        }

                        return { date: nextScheduledDate, hasTime: scheduledDate.hasTime };
                    }
                    return null;
                })();
                if (!newScheduledDate) return;

                const newScheduledDateStr = stringifyOrgDate(newScheduledDate);

                const newContent = currentContent.replace(SCHEDULED_REGEX, `\nSCHEDULED: <${newScheduledDateStr} ${scheduledInterval}>`);
                if (newContent === currentContent) return;
                logseq.UI.showMsg(`Repeating task successfully updated`);
                logseq.Editor.updateBlock(block.uuid, newContent);
            });
        } catch (err) {
            console.error(err);
        }
    });
}

logseq.ready(main).catch(console.error);

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = __importDefault(require("./config"));
const firebase_1 = require("./utils/firebase");
const postgres_1 = require("./utils/postgres");
const stripe_1 = require("./utils/stripe");
const discord_js_1 = require("discord.js");
let lastSubs = '';
let currentSubs = '';
const postgres2 = (0, postgres_1.newPostgres)();
// set up the Discord admin bot
const discordBot = new discord_js_1.Client({
    intents: [discord_js_1.IntentsBitField.Flags.Guilds, discord_js_1.IntentsBitField.Flags.GuildMembers],
});
if (config_1.default.DISCORD_ADMIN_BOT_TOKEN) {
    discordBot.login(config_1.default.DISCORD_ADMIN_BOT_TOKEN);
    // discordBot.once('ready', () => {
    //   console.log(`Discord Bot "${discordBot?.user?.username}" ready`);
    // });
}
if (process.env.NODE_ENV === 'development') {
    setTimeout(syncSubscribers, 1000);
}
setInterval(syncSubscribers, 60 * 1000);
async function syncSubscribers() {
    if (!config_1.default.STRIPE_SECRET_KEY || !config_1.default.FIREBASE_ADMIN_SDK_CONFIG) {
        return;
    }
    console.time('syncSubscribers');
    // Fetch subs, customers from stripe
    const [subs, customers] = await Promise.all([
        (0, stripe_1.getAllActiveSubscriptions)(),
        (0, stripe_1.getAllCustomers)(),
    ]);
    const emailMap = new Map();
    customers.forEach((cust) => {
        emailMap.set(cust.id, cust.email);
    });
    console.log('%s subs in Stripe', subs.length);
    const uidMap = new Map();
    for (let i = 0; i < subs.length; i += 50) {
        // Batch customers and fetch firebase data
        const batch = subs.slice(i, i + 50);
        const fbUsers = await Promise.all(batch
            .map((sub) => emailMap.get(sub.customer)
            ? (0, firebase_1.getUserByEmail)(emailMap.get(sub.customer))
            : null)
            .filter(Boolean));
        fbUsers.forEach((user) => {
            uidMap.set(user?.email, user?.uid);
        });
    }
    let noUID = 0;
    // Create sub objects
    let result = subs
        .map((sub) => {
        let uid = uidMap.get(emailMap.get(sub.customer));
        if (!uid) {
            uid = emailMap.get(sub.customer);
            noUID += 1;
        }
        return {
            customerId: sub.customer,
            email: emailMap.get(sub.customer),
            status: sub.status,
            uid,
        };
    })
        .filter((sub) => sub.uid);
    console.log('%s subs to insert', result.length);
    console.log('%s subs do not have UID, using email', noUID);
    const newResult = result.filter((sub, index) => index === result.findIndex((other) => sub.uid === other.uid));
    console.log('%s deduped subs to insert', newResult.length);
    if (result.length !== newResult.length) {
        // Log the difference
        console.log(result.filter((x) => !newResult.includes(x)));
    }
    result = newResult;
    currentSubs = result
        .map((sub) => sub.uid)
        .sort()
        .join();
    // Upsert to DB
    // console.log(result);
    if (currentSubs !== lastSubs) {
        try {
            await postgres2?.query('BEGIN TRANSACTION');
            await postgres2?.query('DELETE FROM subscriber');
            await postgres2?.query('UPDATE room SET "isSubRoom" = false');
            for (let i = 0; i < result.length; i++) {
                const row = result[i];
                await (0, postgres_1.insertObject)(postgres2, 'subscriber', row);
                await (0, postgres_1.updateObject)(postgres2, 'room', { isSubRoom: true }, { owner: row.uid });
            }
            await postgres2?.query('COMMIT');
            lastSubs = currentSubs;
        }
        catch (e) {
            console.error(e);
            await postgres2?.query('ROLLBACK');
        }
    }
    if (discordBot.isReady() &&
        config_1.default.DISCORD_ADMIN_BOT_SERVER_ID &&
        config_1.default.DISCORD_ADMIN_BOT_SUB_ROLE_ID) {
        console.log('setting discord roles');
        // Update the sub status of users in Discord
        // Join the current subs with linked accounts
        const guild = discordBot.guilds.cache.get(config_1.default.DISCORD_ADMIN_BOT_SERVER_ID);
        const role = guild?.roles.cache.get(config_1.default.DISCORD_ADMIN_BOT_SUB_ROLE_ID);
        const toUpdate = (await postgres2.query(`SELECT la.accountid from subscriber JOIN link_account la ON subscriber.uid = la.uid WHERE la.kind = 'discord'`)).rows;
        console.log('%s users to set sub role', toUpdate.length);
        for (let i = 0; i < toUpdate.length; i++) {
            try {
                const user = await guild?.members.fetch(toUpdate[i].accountid);
                if (user && role) {
                    console.log('assigning role %s to user %s', role, user.id);
                    await user.roles.add(role);
                }
            }
            catch (e) {
                console.log(e.message);
            }
        }
    }
    console.timeEnd('syncSubscribers');
}

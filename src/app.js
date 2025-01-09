const express = require("express");
const bodyParser = require("body-parser");
const { sequelize } = require("./model");
const { Op, fn, col } = require("sequelize");
const { getProfile } = require("./middleware/getProfile");
const app = express();
app.use(bodyParser.json());
app.set("sequelize", sequelize);
app.set("models", sequelize.models);

/**
 * @returns contract of profile by id
 */
app.get("/contracts/:id", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");
  const { id } = req.params;
  const { id: profileId, type } = req.profile;

  const contractRelation = {
    client: { ClientId: profileId },
    contractor: { ContractorId: profileId },
  }[type];

  if (!contractRelation) {
    return res.status(500).end();
  }
  try {
    const contract = await Contract.findOne({
      where: {
        id,
        ...contractRelation,
      },
    });

    if (!contract) {
      return res.status(404).end();
    }

    res.json(contract);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/contracts", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");
  const { id: profileId, type } = req.profile;
  const contractRelation = {
    client: { ClientId: profileId },
    contractor: { ContractorId: profileId },
  }[type];
  if (!contractRelation) {
    return res.status(500).end();
  }

  try {
    const contracts = await Contract.findAll({
      where: {
        ...contractRelation,
        [Op.not]: [{ status: "terminated" }],
      },
    });

    res.json(contracts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/jobs/unpaid", getProfile, async (req, res) => {
  const { Contract, Job } = req.app.get("models");
  const { id: profileId, type } = req.profile;
  const contractRelation = {
    client: { ClientId: profileId },
    contractor: { ContractorId: profileId },
  }[type];
  if (!contractRelation) {
    return res.status(500).end();
  }

  try {
    const jobs = await Job.findAll({
      where: {
        paid: null,
        // [Op.not]: [{ paid: true }], This is probably some bug.
      },
      include: [
        {
          attributes: [],
          model: Contract,
          required: true,
          where: {
            status: "in_progress",
            ...contractRelation,
          },
        },
      ],
    });

    res.json(jobs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /jobs/:job_id/pay - Pay for a job, a client can only pay if his balance >= the amount to pay.
// The amount should be moved from the client's balance to the contractor balance.
app.post("/jobs/:job_id/pay", getProfile, async (req, res) => {
  const { Job, Contract, Profile } = req.app.get("models");
  const { id: profileId, type } = req.profile;
  const { job_id: jobId } = req.params;
  if (type !== "client") {
    return res.status(403).end();
  }

  const sequelize = req.app.get("sequelize");
  try {
    await sequelize.transaction(async (t) => {
      // Do not check if contract is active - no requirement.
      const job = await Job.findOne({
        t,
        lock: t.LOCK.UPDATE,
        where: { id: jobId, paid: null },
      });

      if (!job) {
        throw new Error("Not found");
      }

      const { ContractId: contractId } = job;
      const [client, contractor] = await Promise.all([
        Profile.findOne({
          t,
          lock: t.LOCK.UPDATE,
          where: { id: profileId },
          include: [
            {
              model: Contract,
              as: "Client",
              required: true,
              where: { id: contractId },
              attributes: [],
            },
          ],
        }),
        Profile.findOne({
          t, // We don't need to lock Contractor while paying him.
          include: [
            {
              model: Contract,
              as: "Contractor",
              required: true,
              where: { id: contractId },
              attributes: [],
            },
          ],
        }),
      ]);

      if (!client) {
        throw new Error("Not allowed");
      }
      if (client.balance < job.price) {
        throw new Error("Bad request");
      }
      if (!contractor) {
        throw new Error();
      }

      await Promise.all([
        job.update(
          {
            paymentDate: new Date(),
            paid: true,
          },
          t,
        ),
        contractor.increment("balance", { by: job.price, t }),
        client.decrement("balance", { by: job.price, t }),
      ]);
    });

    return res.status(200).end();
  } catch (error) {
    switch (error.message) {
      case "Not found":
        return res.status(404).end();
      case "Bad request":
        return res.status(400).end();
      case "Not allowed":
        return res.status(403).end();
      default:
        return res.status(500).json({ error: error.message });
    }
  }
});

//POST /balances/deposit/:userId - Deposits money into the the the balance of a client, a client can't deposit more than 25% his total of jobs to pay. (at the deposit moment)
// This one is confusing.
app.post("/balances/deposit/:userId", getProfile, async (req, res) => {
  const { Profile, Contract, Job } = req.app.get("models");
  const amount = parseInt(req.query.amount); // for the sake of testing amount is passed via query

  const profile = req.profile;
  const { id: profileId, type } = profile;
  if (type !== "client") {
    return res.status(403).end();
  }
  try {
    // I dont believe we need any locking while making deposit.
    const unpaidTotal = await Job.sum("price", {
      where: { paid: null },
      include: [
        {
          model: Contract,
          required: true,
          attributes: [],
          include: [
            {
              model: Profile,
              as: "Client",
              required: true,
              where: { id: profileId },
              attributes: [],
            },
          ],
        },
      ],
    });

    if (!unpaidTotal) {
      return res.status(400).end();
    }

    if (unpaidTotal < amount * 4) {
      return res
        .status(400)
        .json({ amount: amount, unpaidTotal: unpaidTotal })
        .end();
    }

    await sequelize.transaction(async (t) => {
      await profile.increment("balance", { by: amount, t });
    });

    res.json({ amount: amount, unpaidTotal: unpaidTotal });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

//GET /admin/best-profession?start=<date>&end=<date> - Returns the profession that earned
// the most money (sum of jobs paid) for any contactor that worked in the query time range.
app.get("/admin/best-profession", async (req, res) => {
  const { Job, Contract, Profile } = req.app.get("models");
  try {
    const start = new Date(req.query.start);
    const end = new Date(req.query.end);

    const result = await Job.findOne({
      attributes: [
        [sequelize.col("Contract.Contractor.profession"), "profession"],
        [fn("SUM", col("price")), "total_earned"],
      ],
      include: [
        {
          model: Contract,
          attributes: [],
          include: [
            {
              model: Profile,
              as: "Contractor",
              attributes: [],
            },
          ],
        },
      ],
      where: {
        paid: true,
        paymentDate: {
          [Op.between]: [start, end],
        },
      },
      group: [col("Contract.Contractor.profession")],
      order: [[fn("SUM", col("price")), "DESC"]],
      raw: true,
    });

    if (!result) {
      return res.status(404).end();
    }

    res.json({ bestProfession: result.profession });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

//GET /admin/best-clients?start=<date>&end=<date>&limit=<integer> -
// returns the clients the paid the most for jobs in the query time period.
// limit query parameter should be applied, default limit is 2.
app.get("/admin/best-clients", async (req, res) => {
  const { Job, Contract, Profile } = req.app.get("models");
  try {
    const start = new Date(req.query.start);
    const end = new Date(req.query.end);
    let limit = 2;
    if (req.query.limit) {
      limit = parseInt(req.query.limit);
    }

    const results = await Job.findAll({
      attributes: [
        [sequelize.col("Contract.Client.id"), "id"],
        [sequelize.col("Contract.Client.firstName"), "firstName"],
        [sequelize.col("Contract.Client.lastName"), "lastName"],
        [fn("SUM", col("price")), "totalPaid"],
      ],
      include: [
        {
          model: Contract,
          attributes: [],
          include: [
            {
              model: Profile,
              as: "Client",
              attributes: [],
            },
          ],
        },
      ],
      where: {
        paid: true,
        paymentDate: {
          [Op.between]: [start, end],
        },
      },
      group: [
        col("Contract.Client.id"),
        col("Contract.Client.firstName"),
        col("Contract.Client.lastName"),
      ],
      order: [[fn("SUM", col("price")), "DESC"]],
      limit: limit,
      raw: true,
    });

    res.json(
      results.map((client) => {
        return {
          id: client.id,
          paid: client.totalPaid,
          fullName: client.firstName + " " + client.lastName,
        };
      }),
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;

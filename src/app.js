const express = require("express");
const bodyParser = require("body-parser");
const { sequelize } = require("./model");
const { Op } = require("sequelize");
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

module.exports = app;

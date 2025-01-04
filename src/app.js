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

module.exports = app;
